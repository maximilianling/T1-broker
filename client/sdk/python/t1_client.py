"""
T1 Broker Python SDK
====================
Programmatic trading client for T1 Broker platform.
Supports equities, crypto, and private markets via API keys.

Quick Start:
    from t1_client import T1Client
    client = T1Client("t1_live_your_api_key_here")
    client.buy("AAPL", 100, order_type="market")
    print(client.positions())

Requirements:
    pip install requests
"""

import requests
import time
import json
from typing import Optional, Union

__version__ = "1.0.0"


class T1Error(Exception):
    """T1 Broker API error."""
    def __init__(self, message, code=None, status=None):
        super().__init__(message)
        self.code = code
        self.status = status


class T1Client:
    """
    T1 Broker Trading Client.

    Args:
        api_key: Your T1 API key (starts with t1_live_)
        base_url: API base URL (default: http://localhost:3000/api/v1)
        timeout: Request timeout in seconds (default: 30)
    """

    def __init__(self, api_key: str, base_url: str = "http://localhost:3000/api/v1", timeout: int = 30):
        if not api_key or not api_key.startswith("t1_live_"):
            raise T1Error("Invalid API key format. Keys must start with 't1_live_'")
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update({
            "X-API-Key": api_key,
            "Content-Type": "application/json",
            "User-Agent": f"T1-Python-SDK/{__version__}",
        })

    def _request(self, method: str, path: str, data: dict = None, params: dict = None) -> dict:
        """Make an authenticated API request."""
        url = f"{self.base_url}{path}"
        try:
            resp = self.session.request(method, url, json=data, params=params, timeout=self.timeout)
            result = resp.json() if resp.content else {}
            if resp.status_code >= 400:
                raise T1Error(
                    result.get("error", f"HTTP {resp.status_code}"),
                    code=result.get("code"),
                    status=resp.status_code,
                )
            return result
        except requests.exceptions.ConnectionError:
            raise T1Error("Cannot connect to T1 Broker. Check base_url and server status.")
        except requests.exceptions.Timeout:
            raise T1Error("Request timed out.")

    # ── TRADING ──────────────────────────────────────────────────

    def place_order(self, instrument_id: int, side: str, order_type: str,
                    quantity: float, price: float = None, stop_price: float = None,
                    time_in_force: str = "day", account_id: int = None) -> dict:
        """
        Place a single order.

        Args:
            instrument_id: Instrument ID (use search_instruments to find)
            side: "buy" or "sell"
            order_type: "market", "limit", "stop", "stop_limit"
            quantity: Number of shares/units
            price: Limit price (required for limit/stop_limit)
            stop_price: Stop trigger price (required for stop/stop_limit)
            time_in_force: "day" (default), "gtc", "ioc", "fok"
            account_id: Trading account ID (default: primary)

        Returns:
            Order details dict with id, status, etc.
        """
        payload = {
            "instrumentId": instrument_id,
            "side": side,
            "orderType": order_type,
            "quantity": quantity,
            "timeInForce": time_in_force,
        }
        if price is not None:
            payload["price"] = price
        if stop_price is not None:
            payload["stopPrice"] = stop_price
        if account_id is not None:
            payload["accountId"] = account_id
        return self._request("POST", "/orders", payload)

    def buy(self, symbol: str, quantity: float, order_type: str = "market",
            price: float = None, time_in_force: str = "day") -> dict:
        """
        Quick buy by symbol name.

        Args:
            symbol: Ticker symbol (e.g. "AAPL", "BTC/USD")
            quantity: Number of shares/units
            order_type: "market" (default), "limit", "stop", "stop_limit"
            price: Limit price (required for limit orders)
            time_in_force: "day" (default), "gtc", "ioc", "fok"
        """
        inst = self._resolve_symbol(symbol)
        return self.place_order(inst["id"], "buy", order_type, quantity, price=price, time_in_force=time_in_force)

    def sell(self, symbol: str, quantity: float, order_type: str = "market",
             price: float = None, time_in_force: str = "day") -> dict:
        """Quick sell by symbol name."""
        inst = self._resolve_symbol(symbol)
        return self.place_order(inst["id"], "sell", order_type, quantity, price=price, time_in_force=time_in_force)

    def batch_orders(self, orders: list) -> dict:
        """
        Place multiple orders simultaneously (max 20).

        Args:
            orders: List of order dicts, each with:
                - instrumentId (int) or symbol (str)
                - side: "buy" / "sell"
                - orderType: "market" / "limit" / "stop" / "stop_limit"
                - quantity (float)
                - price (float, optional)
                - stopPrice (float, optional)
                - timeInForce (str, optional)

        Returns:
            Dict with placed, failed, total, and results array.

        Example:
            client.batch_orders([
                {"symbol": "AAPL", "side": "buy", "orderType": "market", "quantity": 100},
                {"symbol": "BTC/USD", "side": "buy", "orderType": "limit", "quantity": 0.5, "price": 95000},
                {"symbol": "MSFT", "side": "sell", "orderType": "market", "quantity": 50},
            ])
        """
        resolved = []
        for o in orders:
            order = dict(o)
            if "symbol" in order and "instrumentId" not in order:
                inst = self._resolve_symbol(order.pop("symbol"))
                order["instrumentId"] = inst["id"]
            resolved.append(order)
        return self._request("POST", "/orders/batch", {"orders": resolved})

    def cancel_order(self, order_id: int) -> dict:
        """Cancel a pending order."""
        return self._request("DELETE", f"/orders/{order_id}")

    def cancel_all(self, status: str = "pending") -> list:
        """Cancel all orders with given status. Returns list of results."""
        orders = self.list_orders(status=status)
        results = []
        for o in orders:
            try:
                self.cancel_order(o["id"])
                results.append({"id": o["id"], "cancelled": True})
            except T1Error as e:
                results.append({"id": o["id"], "cancelled": False, "error": str(e)})
        return results

    def list_orders(self, status: str = None, limit: int = 50) -> list:
        """List orders. Filter by status: pending, filled, cancelled, rejected."""
        params = {"limit": limit}
        if status:
            params["status"] = status
        result = self._request("GET", "/orders", params=params)
        return result.get("data", result) if isinstance(result, dict) else result

    def get_order(self, order_id: int) -> dict:
        """Get order details by ID."""
        return self._request("GET", f"/orders/{order_id}")

    # ── POSITIONS ────────────────────────────────────────────────

    def positions(self) -> list:
        """Get all open positions with P&L."""
        result = self._request("GET", "/positions")
        return result.get("data", result) if isinstance(result, dict) else result

    def position_by_symbol(self, symbol: str) -> Optional[dict]:
        """Get position for a specific symbol, or None."""
        for p in self.positions():
            if p.get("symbol", "").upper() == symbol.upper():
                return p
        return None

    def portfolio_value(self) -> dict:
        """Calculate total portfolio value and P&L."""
        pos = self.positions()
        total_value = sum(float(p.get("marketValue", 0) or 0) for p in pos)
        total_cost = sum(float(p.get("quantity", 0)) * float(p.get("avgCost", 0) or p.get("avg_cost", 0)) for p in pos)
        total_pnl = sum(float(p.get("unrealizedPnl", 0) or p.get("unrealized_pnl", 0)) for p in pos)
        return {
            "positions": len(pos),
            "marketValue": round(total_value, 2),
            "costBasis": round(total_cost, 2),
            "unrealizedPnl": round(total_pnl, 2),
            "pnlPercent": round((total_pnl / total_cost * 100) if total_cost else 0, 2),
        }

    # ── MARKET DATA ──────────────────────────────────────────────

    def search_instruments(self, query: str = None, asset_class: str = None,
                           exchange: str = None, limit: int = 50) -> list:
        """
        Search tradable instruments.

        Args:
            query: Symbol or name search (e.g. "AAPL", "Bitcoin", "Tesla")
            asset_class: Filter by type: "equity", "crypto", "etf", "forex", "option"
            exchange: Filter by exchange: "NASDAQ", "NYSE", "CRYPTO"
            limit: Max results (default 50)
        """
        params = {"limit": limit}
        if query:
            params["search"] = query
        if asset_class:
            params["assetClass"] = asset_class
        if exchange:
            params["exchange"] = exchange
        result = self._request("GET", "/market/instruments", params=params)
        return result.get("data", [])

    def get_quote(self, symbol: str) -> dict:
        """Get real-time quote for a symbol."""
        return self._request("GET", f"/market/quotes/{symbol}")

    def get_quotes(self, symbols: list) -> list:
        """Get quotes for multiple symbols."""
        results = []
        for sym in symbols:
            try:
                q = self.get_quote(sym)
                results.append(q)
            except T1Error:
                results.append({"symbol": sym, "error": "Not found"})
        return results

    def _resolve_symbol(self, symbol: str) -> dict:
        """Resolve a ticker symbol to an instrument record."""
        instruments = self.search_instruments(query=symbol, limit=5)
        for inst in instruments:
            if inst.get("symbol", "").upper() == symbol.upper():
                return inst
        if instruments:
            return instruments[0]
        raise T1Error(f"Instrument not found: {symbol}")

    # ── ACCOUNT ──────────────────────────────────────────────────

    def profile(self) -> dict:
        """Get account profile and KYC status."""
        return self._request("GET", "/clients/me")

    def accounts(self) -> list:
        """List trading accounts with balances."""
        result = self._request("GET", "/clients/me/accounts")
        return result.get("data", result) if isinstance(result, dict) else result

    # ── API KEYS ─────────────────────────────────────────────────

    def list_api_keys(self) -> list:
        """List all API keys (previews only)."""
        result = self._request("GET", "/api-keys")
        return result.get("data", [])

    # ── UTILITIES ────────────────────────────────────────────────

    def ping(self) -> bool:
        """Test API connectivity."""
        try:
            self._request("GET", "/health")
            return True
        except T1Error:
            return False

    def __repr__(self):
        preview = self.api_key[:16] + "..." + self.api_key[-4:]
        return f"T1Client(key='{preview}', url='{self.base_url}')"


# ── CONVENIENCE: Run as script for quick testing ─────────────────
if __name__ == "__main__":
    import sys
    import os

    key = os.environ.get("T1_API_KEY") or (sys.argv[1] if len(sys.argv) > 1 else None)
    url = os.environ.get("T1_BASE_URL", "http://localhost:3000/api/v1")

    if not key:
        print("T1 Broker Python SDK v" + __version__)
        print("=" * 40)
        print("Usage:")
        print("  export T1_API_KEY=t1_live_your_key_here")
        print("  python t1_client.py")
        print("")
        print("Or in your code:")
        print('  from t1_client import T1Client')
        print('  client = T1Client("t1_live_...")')
        print('  client.buy("AAPL", 100)')
        print('  print(client.positions())')
        sys.exit(0)

    client = T1Client(key, base_url=url)
    print(f"Connected: {client}")
    print(f"Ping: {'OK' if client.ping() else 'FAILED'}")

    try:
        pv = client.portfolio_value()
        print(f"\nPortfolio: {pv['positions']} positions, ${pv['marketValue']:,.2f} value, ${pv['unrealizedPnl']:+,.2f} P&L")
    except T1Error as e:
        print(f"Portfolio: {e}")

    try:
        instruments = client.search_instruments(limit=5)
        print(f"\nSample instruments: {', '.join(i['symbol'] for i in instruments[:5])}")
    except T1Error as e:
        print(f"Instruments: {e}")
