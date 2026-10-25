"""The client: talks to the shop through a transport (see shop/transport.py)."""


class Client:
    def __init__(self, transport):
        self.transport = transport

    def ping(self):
        return self.transport.send({"type": "ping"}).get("type") == "pong"
