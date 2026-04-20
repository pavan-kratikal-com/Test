FROM python:3.11-slim

WORKDIR /app

# Install PyTorch CPU-only + dependencies
RUN pip install --no-cache-dir \
    torch --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir \
    tokenizers fastapi uvicorn pydantic

# Copy model files and code
COPY model.pt email_tokenizer.json ./
COPY server.py inference.py model.py dataset.py ./

EXPOSE 7070

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "7070"]
