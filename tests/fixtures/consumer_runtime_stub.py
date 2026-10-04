"""A controlled loopback runtime for consumer-session process tests; never loads model weights."""

import argparse
import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from kev.local import load_registry, resolve_model


def _answers(request):
    answers = {}
    for question_id, question in request["questions"].items():
        kind = question["type"]
        if kind == "noul":
            answers[question_id] = {"type": "noul", "noul": 0.75}
        elif kind == "choice":
            keys = list(question["criteria"])
            p = round(1 / len(keys), 4)
            answers[question_id] = {
                "type": "choice",
                "choice": keys[0],
                "confidence": 0.0,
                "probabilities": {key: p for key in keys},
            }
        else:
            levels = question["criteria"]
            probabilities = {str(i): round(1 / len(levels), 4) for i in range(len(levels))}
            answers[question_id] = {
                "type": "score",
                "score": round(sum(i * p for i, p in enumerate([1 / len(levels)] * len(levels))), 4),
                "legend": {str(i): level for i, level in enumerate(levels)},
                "probabilities": probabilities,
                "confidence": 0.0,
            }
    return answers


class Handler(BaseHTTPRequestHandler):
    server_version = "ConsumerRuntimeStub/1"

    def log_message(self, fmt, *args):
        return

    def _json(self, status, body):
        encoded = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self):
        if self.path != "/v1/models":
            return self._json(404, {"detail": "not found"})
        self._json(200, self.server.models)

    def do_POST(self):
        if self.path == "/__kev/consumer/shutdown":
            if self.headers.get("x-kev-owner-token") != self.server.owner_token:
                return self._json(403, {"detail": "invalid owner token"})
            if self.server.deny_shutdown:
                return self._json(503, {"detail": "controlled shutdown refusal"})
            if self.server.hold_shutdown:
                return self._json(200, {"state": "closing"})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return self._json(200, {"state": "closing"})
        if self.path == "/__test/shutdown":
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return self._json(200, {"state": "closing"})
        if self.path != "/v1/systemone":
            return self._json(404, {"detail": "not found"})
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        with self.server.trace_lock:
            self.server.trace["calls"] += 1
            self.server.trace["requests"].append(
                {
                    "model": request["model"],
                    "questions": {key: value["type"] for key, value in request["questions"].items()},
                }
            )
            self.server.trace_path.write_text(json.dumps(self.server.trace), encoding="utf-8")
        self._json(
            200,
            {
                "model": request["model"],
                "answers": _answers(request),
                "usage": {"input_tokens": 12, "output_tokens": 4},
                "latency_ms": 1.0,
            },
        )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--model-id", required=True)
    parser.add_argument("--fd", required=True, type=int)
    parser.add_argument("--owner-token", required=True)
    parser.add_argument("--session-record", required=True)
    parser.add_argument("--trace", required=True)
    parser.add_argument("--ready-delay", type=float, default=0)
    parser.add_argument("--wrong-model", action="store_true")
    parser.add_argument("--deny-shutdown", action="store_true")
    parser.add_argument("--hold-shutdown", action="store_true")
    args = parser.parse_args()

    resolved = resolve_model(load_registry(args.config), args.model_id)
    identity = resolved.card(backend="mlx", dtype="bfloat16", device="mps")
    if args.wrong_model:
        identity["model_id"] = "kev-unexpected"
    models = {"models": [{"name": "kev-latest", "local": identity}]}
    trace_path = Path(args.trace)
    trace_path.write_text(json.dumps({"loads": 1, "calls": 0, "requests": []}), encoding="utf-8")

    if args.ready_delay:
        time.sleep(args.ready_delay)
    server = HTTPServer(("127.0.0.1", 0), Handler, bind_and_activate=False)
    server.socket.close()
    server.socket = socket.socket(fileno=args.fd)
    server.server_address = server.socket.getsockname()
    server.models = models
    server.owner_token = args.owner_token
    server.deny_shutdown = args.deny_shutdown
    server.hold_shutdown = args.hold_shutdown
    server.trace = {"loads": 1, "calls": 0, "requests": []}
    server.trace_path = trace_path
    server.trace_lock = threading.Lock()
    server.serve_forever(poll_interval=0.05)


if __name__ == "__main__":
    main()
