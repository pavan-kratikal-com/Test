"""FastAPI server with OpenAI-compatible API for email classification.

Adapted for e2_slm integration: parses both JSON email dicts and the
plain-text prompt format that e2_slm sends in classifier mode:

    From: sender@example.com
    To: recipient@example.com
    Subject: ...
    Body: ...
"""

import json
import re
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from inference import EmailClassifierInference

MODEL_DIR = Path(__file__).parent
app = FastAPI(title="Email Classifier API", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
classifier = None


class EmailInput(BaseModel):
    """Single email for classification."""
    from_addr: str = Field("", alias="from")
    to: str = ""
    subject: str = ""
    body_plain: str = ""
    received_hops: int = 0
    has_attachment: bool = False
    security_headers: dict = Field(default_factory=dict)
    rspamd: dict = Field(default_factory=dict)
    iocs: dict = Field(default_factory=dict)

    model_config = {"populate_by_name": True}


class ClassificationResult(BaseModel):
    label: str
    confidence: float
    reason: str
    threat_score: float
    threats: list[str]


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    """OpenAI-compatible chat completion request."""
    model: str = "email-classifier-v1"
    messages: list[ChatMessage]
    temperature: float = 0.0
    max_tokens: int = 128000


class ChatResponse(BaseModel):
    """OpenAI-compatible chat completion response."""
    id: str
    object: str = "chat.completion"
    created: int
    model: str
    choices: list[dict]
    usage: dict


def parse_email_from_prompt(content: str) -> dict:
    """Parse e2_slm's text prompt back into an email dict.

    e2_slm classifier mode sends:
        From: sender@example.com
        To: recipient@example.com
        Subject: Urgent wire transfer
        Body: Please wire $50k immediately

    Also handles JSON input (passthrough) and extracts prior_signals
    if present in the prompt.
    """
    # Try JSON first
    try:
        return json.loads(content)
    except (json.JSONDecodeError, TypeError):
        pass

    # Parse structured text format
    email = {"from": "", "to": "", "subject": "", "body_plain": "", "rspamd": {}, "iocs": {}}
    lines = content.split("\n")
    body_lines = []
    in_body = False
    in_signals = False
    prior_signals_text = []

    for line in lines:
        # Check for prior signals section
        if line.startswith("Prior signals:") or line.startswith("PRIOR SIGNALS:"):
            in_signals = True
            sig_rest = line.split(":", 1)[1].strip()
            if sig_rest and sig_rest != "none":
                prior_signals_text.append(sig_rest)
            continue

        if in_signals:
            # Signals section ends when we hit an empty line or a new header
            if not line.strip() or (re.match(r'^[A-Z][a-z]+:', line) and not line.startswith("rspamd.")):
                in_signals = False
            else:
                prior_signals_text.append(line.strip())
                continue

        if in_body:
            body_lines.append(line)
        elif line.startswith("From: "):
            email["from"] = line[6:].strip()
        elif line.startswith("To: "):
            email["to"] = line[4:].strip()
        elif line.startswith("Subject: "):
            email["subject"] = line[9:].strip()
        elif line.startswith("Body: "):
            body_lines.append(line[6:])
            in_body = True
        elif line.startswith("Body:"):
            # "Body:" with content on next line
            in_body = True

    email["body_plain"] = "\n".join(body_lines).strip()

    # Extract rspamd symbols from prior signals if present
    # Format: "rspamd.SYMBOL_NAME (score=X), rspamd.OTHER (score=Y)"
    if prior_signals_text:
        signals_str = ", ".join(prior_signals_text)
        fired_symbols = []
        for match in re.finditer(r'rspamd\.(\w+)\s*\(score=([\d.]+)\)', signals_str):
            fired_symbols.append({
                "name": match.group(1),
                "score": float(match.group(2)),
            })
        if fired_symbols:
            email["rspamd"] = {"fired_symbols": fired_symbols}

    return email


@app.on_event("startup")
def load_model():
    global classifier
    classifier = EmailClassifierInference(
        model_path=MODEL_DIR / "model.pt",
        tokenizer_path=MODEL_DIR / "email_tokenizer.json",
    )


@app.post("/classify", response_model=ClassificationResult)
def classify_email(email: EmailInput):
    """Classify a single email."""
    email_dict = email.model_dump(by_alias=True)
    result = classifier.classify(email_dict)
    return result


@app.post("/v1/chat/completions")
def chat_completions(request: ChatRequest):
    """OpenAI-compatible endpoint. Extracts email from last user message.

    Handles both:
    - JSON email dicts (direct API usage)
    - Plain-text prompts from e2_slm classifier mode
    """
    last_msg = next((m for m in reversed(request.messages) if m.role == "user"), None)
    if not last_msg:
        raise HTTPException(400, "No user message found")

    email_dict = parse_email_from_prompt(last_msg.content)
    result = classifier.classify(email_dict)
    content = json.dumps(result, indent=2)

    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:12]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": request.model,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": content},
            "finish_reason": "stop",
        }],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    }


@app.get("/v1/models")
def list_models():
    """OpenAI-compatible model listing."""
    return {
        "object": "list",
        "data": [
            {
                "id": "email-classifier-v1",
                "object": "model",
                "created": 1713364800,
                "owned_by": "kratikal",
                "permission": [],
                "root": "email-classifier-v1",
                "parent": None,
            }
        ],
    }


@app.get("/v1/models/{model_id}")
def get_model(model_id: str):
    """OpenAI-compatible model detail."""
    if model_id != "email-classifier-v1":
        raise HTTPException(404, f"Model '{model_id}' not found")
    return {
        "id": "email-classifier-v1",
        "object": "model",
        "created": 1713364800,
        "owned_by": "kratikal",
    }


@app.get("/health")
def health():
    return {"status": "ok", "model": "email-classifier-v1"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=7070)
