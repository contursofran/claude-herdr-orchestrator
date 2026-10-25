import unittest

from shop.client import Client
from shop.server import handle
from shop.transport import LocalTransport


class ClientTest(unittest.TestCase):
    def test_ping_gets_a_pong(self):
        self.assertTrue(Client(LocalTransport(handle)).ping())
