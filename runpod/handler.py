import os
import subprocess
import time

import requests
import runpod

MODEL = os.environ.get("OLLAMA_MODEL", "llama3.2")
BASE = "http://127.0.0.1:11434"

DRAFT_TIMEOUT_SECONDS = 240


def start_ollama():
    subprocess.Popen(["ollama", "serve"])
    for _ in range(120):
        try:
            requests.get(f"{BASE}/api/tags", timeout=1).raise_for_status()
            return
        except requests.RequestException:
            time.sleep(1)
    raise RuntimeError("Ollama did not answer within two minutes of being started.")


start_ollama()


def handler(job):
    data = job.get("input") or {}
    messages = data.get("messages")
    if not messages:
        return {"error": "That job carries no messages, so there is nothing to answer."}

    model = data.get("model") or MODEL
    body = {"model": model, "messages": messages, "stream": False}
    if data.get("options"):
        body["options"] = data["options"]

    try:
        answer = requests.post(f"{BASE}/api/chat", json=body, timeout=DRAFT_TIMEOUT_SECONDS)
        answer.raise_for_status()
    except requests.RequestException as error:
        return {"error": f"Ollama would not answer: {error}"}

    payload = answer.json()

    return {
        "content": (payload.get("message") or {}).get("content", ""),
        "model": payload.get("model", model),
        "prompt_tokens": payload.get("prompt_eval_count"),
        "completion_tokens": payload.get("eval_count"),
    }


runpod.serverless.start({"handler": handler})
