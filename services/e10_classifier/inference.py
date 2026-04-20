"""Load trained model and classify emails."""

import json
import argparse
from pathlib import Path

import torch
from tokenizers import Tokenizer

from dataset import (
    LABELS, ID2LABEL, THREAT_CATEGORIES, NUM_FEATURES, NUM_THREATS,
    extract_features, extract_threat_scores, build_reason,
)
from model import EmailClassifier

MODEL_DIR = Path(__file__).parent
DEVICE = (
    "cuda" if torch.cuda.is_available()
    else "cpu"
)


class EmailClassifierInference:
    def __init__(self, model_path: Path = None, tokenizer_path: Path = None):
        model_path = model_path or MODEL_DIR / "model.pt"
        tokenizer_path = tokenizer_path or MODEL_DIR / "email_tokenizer.json"

        # Load tokenizer
        self.tokenizer = Tokenizer.from_file(str(tokenizer_path))

        # Load model
        checkpoint = torch.load(model_path, map_location=DEVICE, weights_only=True)
        config = checkpoint.get("config", {})
        self.model = EmailClassifier(**config)
        self.model.load_state_dict(checkpoint["model_state_dict"])
        self.model.to(DEVICE)
        self.model.eval()

        val_acc = checkpoint.get("val_acc", 0)
        epoch = checkpoint.get("epoch", 0)
        print(f"Loaded model (epoch {epoch}, val_acc={val_acc:.1%}) on {DEVICE}")

    @torch.no_grad()
    def classify(self, email: dict) -> dict:
        """Classify a single email dict (enriched format)."""
        # Tokenize text
        sender = email.get("from", "")
        subject = email.get("subject", "")
        body = email.get("body_plain", "")
        text = f"From: {sender}\nSubject: {subject}\n\n{body}"

        encoding = self.tokenizer.encode(text)
        input_ids = torch.tensor([encoding.ids], dtype=torch.long, device=DEVICE)
        attention_mask = torch.tensor([encoding.attention_mask], dtype=torch.float32, device=DEVICE)

        # Features
        features = extract_features(email).unsqueeze(0).to(DEVICE)

        # Forward
        logits, threat_preds = self.model(input_ids, attention_mask, features)

        # Classification
        probs = torch.softmax(logits, dim=-1)[0]
        label_idx = probs.argmax().item()
        label = ID2LABEL[label_idx]
        confidence = probs[label_idx].item()

        # Threat scores
        threat_raw = threat_preds[0].cpu().tolist()
        # Denormalize (we divided by 5 during training)
        threat_scores = [max(0, s * 5.0) for s in threat_raw]
        total_threat = sum(threat_scores)

        # Build threats list (only non-zero)
        threats = []
        for i, score in enumerate(threat_scores):
            if score > 0.3:  # threshold
                cat_name = THREAT_CATEGORIES[i].split(". ", 1)[1] if ". " in THREAT_CATEGORIES[i] else THREAT_CATEGORIES[i]
                threats.append(f"{cat_name}:{score:.1f}")

        # Reason
        reason = build_reason(email)

        return {
            "label": label,
            "confidence": round(confidence, 3),
            "reason": reason,
            "threat_score": round(total_threat, 1),
            "threats": threats,
        }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, default=MODEL_DIR / "model.pt")
    parser.add_argument("--tokenizer", type=Path, default=MODEL_DIR / "email_tokenizer.json")
    parser.add_argument("--input", type=Path, help="JSONL file or single JSON email")
    parser.add_argument("--email-json", type=str, help="Inline JSON email string")
    args = parser.parse_args()

    clf = EmailClassifierInference(args.model, args.tokenizer)

    if args.email_json:
        email = json.loads(args.email_json)
        result = clf.classify(email)
        print(json.dumps(result, indent=2))
    elif args.input:
        results = clf.classify_file(args.input)
        for r in results[:10]:
            print(f"[{r['label']:>10}] {r['confidence']:.0%} | threat={r['threat_score']:>4.1f} | {r['subject'][:60]}")


if __name__ == "__main__":
    main()
