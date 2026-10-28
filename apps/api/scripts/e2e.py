"""Uploads a PDF to a local `wrangler dev` and starts a run. Usage: e2e.py <pdf> <preset>..."""
import json
import sys
import urllib.request

API = "http://localhost:8787"
HEADERS = {"x-evalmydocs-user": "dev@example.com"}
BYOK_KEYS = {"llamaparse": "LLAMA_CLOUD_API_KEY", "extend": "EXTEND_API_KEY", "datalab": "DATALAB_API_KEY", "pulse": "PULSE_API_KEY", "mistral_ocr": "MISTRAL_API_KEY", "cohere": "COHERE_API_KEY"}


def post(path: str, data: bytes, content_type: str) -> dict:
    request = urllib.request.Request(f"{API}{path}", data=data, headers={**HEADERS, "content-type": content_type})
    return json.load(urllib.request.urlopen(request))


pdf, presets = sys.argv[1], sys.argv[2:]
dev_vars = dict(line.split("=", 1) for line in open(".dev.vars").read().splitlines() if "=" in line)
catalog = {p["id"]: p for p in json.load(urllib.request.urlopen(f"{API}/v1/presets"))}
credentials = {
    catalog[p]["provider"]: {BYOK_KEYS[catalog[p]["provider"]]: dev_vars[BYOK_KEYS[catalog[p]["provider"]]].strip('"')}
    for p in presets
    if not catalog[p]["hosted"]
}
document = post("/v1/documents?filename=" + pdf.rsplit("/", 1)[-1], open(pdf, "rb").read(), "application/pdf")
run = post("/v1/runs", json.dumps({"documentIds": [document["documentId"]], "presetIds": presets, "credentials": credentials}).encode(), "application/json")
print(json.dumps({**document, **run}))
