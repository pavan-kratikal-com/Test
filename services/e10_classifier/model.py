"""Small Transformer Encoder + Classification Heads (~3M params)."""

import math
import torch
import torch.nn as nn
import torch.nn.functional as F

from dataset import NUM_FEATURES, NUM_THREATS, LABELS


class TransformerEncoderBlock(nn.Module):
    def __init__(self, d_model: int, n_heads: int, d_ff: int, dropout: float = 0.1):
        super().__init__()
        self.attn = nn.MultiheadAttention(d_model, n_heads, dropout=dropout, batch_first=True)
        self.norm1 = nn.LayerNorm(d_model)
        self.ffn = nn.Sequential(
            nn.Linear(d_model, d_ff),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(d_ff, d_model),
            nn.Dropout(dropout),
        )
        self.norm2 = nn.LayerNorm(d_model)
        self.dropout = nn.Dropout(dropout)

    def forward(self, x, mask=None):
        # Self-attention with residual
        attn_out, _ = self.attn(x, x, x, key_padding_mask=mask)
        x = self.norm1(x + self.dropout(attn_out))
        # FFN with residual
        x = self.norm2(x + self.ffn(x))
        return x


class EmailClassifier(nn.Module):
    """
    Small transformer encoder for email classification.

    Architecture:
    - Token embeddings (8000 x 128) + positional embeddings (512 x 128)
    - 4 transformer encoder layers (4 heads, dim=128, FFN=512)
    - Feature branch: 177 -> 64
    - Classification head: 192 -> 5 classes
    - Threat head: 192 -> 7 threat scores
    """

    def __init__(
        self,
        vocab_size: int = 8000,
        max_len: int = 512,
        d_model: int = 128,
        n_heads: int = 4,
        n_layers: int = 4,
        d_ff: int = 512,
        num_features: int = NUM_FEATURES,  # 177
        feature_dim: int = 64,
        num_classes: int = len(LABELS),  # 5
        num_threats: int = NUM_THREATS,  # 7
        dropout: float = 0.1,
    ):
        super().__init__()
        self.d_model = d_model

        # Token + positional embeddings
        self.token_emb = nn.Embedding(vocab_size, d_model, padding_idx=0)
        self.pos_emb = nn.Embedding(max_len, d_model)
        self.emb_dropout = nn.Dropout(dropout)

        # Transformer encoder layers
        self.layers = nn.ModuleList([
            TransformerEncoderBlock(d_model, n_heads, d_ff, dropout)
            for _ in range(n_layers)
        ])
        self.norm = nn.LayerNorm(d_model)

        # Feature branch: rspamd symbols + numeric -> 64
        self.feature_branch = nn.Sequential(
            nn.Linear(num_features, feature_dim),
            nn.ReLU(),
            nn.Dropout(dropout),
        )

        # Combined dim = d_model (128) + feature_dim (64) = 192
        combined_dim = d_model + feature_dim

        # Classification head -> 5 labels
        self.classifier = nn.Sequential(
            nn.Linear(combined_dim, combined_dim // 2),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(combined_dim // 2, num_classes),
        )

        # Threat head -> 7 threat scores
        self.threat_head = nn.Sequential(
            nn.Linear(combined_dim, combined_dim // 2),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(combined_dim // 2, num_threats),
        )

        self._init_weights()

    def _init_weights(self):
        for p in self.parameters():
            if p.dim() > 1:
                nn.init.xavier_uniform_(p)

    def forward(self, input_ids, attention_mask, features):
        B, T = input_ids.shape

        # Embeddings
        positions = torch.arange(T, device=input_ids.device).unsqueeze(0).expand(B, T)
        x = self.token_emb(input_ids) + self.pos_emb(positions)
        x = self.emb_dropout(x)

        # Attention mask: True = ignore for MultiheadAttention key_padding_mask
        pad_mask = (attention_mask == 0)

        # Transformer layers
        for layer in self.layers:
            x = layer(x, mask=pad_mask)
        x = self.norm(x)

        # Pool: use CLS token (position 0)
        cls_output = x[:, 0, :]  # (B, d_model)

        # Feature branch
        feat = self.feature_branch(features)  # (B, 64)

        # Combine
        combined = torch.cat([cls_output, feat], dim=-1)  # (B, 192)

        # Heads
        logits = self.classifier(combined)  # (B, 5)
        threat_scores = self.threat_head(combined)  # (B, 7)

        return logits, threat_scores

    def count_parameters(self):
        return sum(p.numel() for p in self.parameters() if p.requires_grad)


def build_model(**kwargs) -> EmailClassifier:
    model = EmailClassifier(**kwargs)
    print(f"Model parameters: {model.count_parameters():,}")
    return model
