import unittest

from shop.client import Client
from shop.server import handle
from shop.transport import LocalTransport


class QuoteHiddenTest(unittest.TestCase):
    def client(self):
        return Client(LocalTransport(handle))

    def test_quote_plain(self):
        self.assertEqual(self.client().quote([{"sku": "pen", "qty": 2}]), "Total: $3.00")

    def test_quote_discount(self):
        self.assertEqual(self.client().quote([{"sku": "mug", "qty": 10}]), "Total: $108.00")

    def test_quote_unknown_sku(self):
        with self.assertRaises(ValueError) as cm:
            self.client().quote([{"sku": "nope", "qty": 1}])
        self.assertIn("nope", str(cm.exception))
