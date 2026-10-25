"""Transports carry a request dict to a handler and bring back its reply dict."""

import json


class LocalTransport:
    """Calls a handler in this process. The request and the reply both go through JSON, as they would over a wire."""

    def __init__(self, handler):
        self.handler = handler

    def send(self, request):
        reply = self.handler(json.loads(json.dumps(request)))
        return json.loads(json.dumps(reply))
