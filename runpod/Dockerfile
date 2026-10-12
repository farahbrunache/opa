FROM ollama/ollama:latest

ARG OLLAMA_MODEL=llama3.2
ENV OLLAMA_MODEL=${OLLAMA_MODEL}

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip curl \
 && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir --break-system-packages runpod requests

RUN (ollama serve &) \
 && for _ in $(seq 1 60); do curl -sf http://127.0.0.1:11434/api/tags >/dev/null && break; sleep 1; done \
 && ollama pull "$OLLAMA_MODEL"

COPY handler.py /handler.py

ENTRYPOINT []
CMD ["python3", "-u", "/handler.py"]
