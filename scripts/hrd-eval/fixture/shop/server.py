"""The shop's server. handle() takes a request dict and returns a reply dict; the request's "type" picks what it does."""

PRICES = {"mug": 1200, "pen": 150, "book": 2500}  # sku -> price in cents


def handle(request):
    kind = request.get("type")
    if kind == "ping":
        return {"type": "pong"}
    return {"type": "error", "error": f"unknown request type {kind!r}"}
