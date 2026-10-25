import unittest

from shop.cart import total


class CartTest(unittest.TestCase):
    def test_a_cart_below_the_bulk_threshold_costs_its_subtotal(self):
        self.assertEqual(total([{"price": 150, "qty": 2}]), 300)

    def test_a_cart_at_100_00_gets_ten_percent_off(self):
        self.assertEqual(total([{"price": 1000, "qty": 10}]), 9000)

    def test_a_cart_just_under_100_00_is_not_discounted(self):
        self.assertEqual(total([{"price": 9999, "qty": 1}]), 9999)
