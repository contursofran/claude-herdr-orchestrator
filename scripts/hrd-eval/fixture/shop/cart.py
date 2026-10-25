"""Pricing for a cart. Money is in cents, as ints."""

BULK_THRESHOLD = 10000  # a subtotal of 100.00 or more gets the bulk discount
BULK_PERCENT = 10


def subtotal(items):
    """The sum of price * qty over items, each a dict with "price" (cents) and "qty"."""
    return sum(item["price"] * item["qty"] for item in items)


def total(items):
    """What the cart costs, in cents: the subtotal, less 10% when it is 100.00 or more."""
    amount = subtotal(items)
    if amount >= BULK_THRESHOLD:
        return amount - amount * BULK_PERCENT // 100
    return amount
