"""Signs and sends Lighter transactions for the Node bot, with Lighter's official SDK.

Lighter signs with its own scheme through a native library shipped in the SDK, so this stays in
Python. Reads (balance, positions, prices) are done by the bot itself over Lighter's public API.
Protocol: one JSON request per line on stdin, one JSON answer per line on stdout, same "id".
Nothing but answers is ever written to stdout.
"""

import asyncio
import json
import sys
import time

import lighter
from lighter.signer_client import SignerClient, create_api_key, decode_and_free

BTC_MARKET = 1
client = None


def answer(req_id, **fields):
    sys.stdout.write(json.dumps({"id": req_id, **fields}) + "\n")
    sys.stdout.flush()


def sent(resp, err):
    if err is not None:
        return {"ok": False, "error": str(err)}
    if resp is not None and getattr(resp, "code", 200) != 200:
        return {"ok": False, "error": f"{resp.code} {resp.message}"}
    return {"ok": True, "tx": getattr(resp, "tx_hash", None)}


async def handle(req):
    global client
    cmd = req["cmd"]

    if cmd == "newkey":
        private_key, public_key, err = create_api_key()
        if err:
            return {"ok": False, "error": err}
        return {"ok": True, "private_key": private_key, "public_key": public_key}

    if cmd == "init":
        if client is not None:
            await client.close()
        client = SignerClient(req["url"], req["account_index"], {req["api_key_index"]: req["private_key"]})
        err = None if req.get("unregistered") else client.check_client()
        return {"ok": err is None, "error": err}

    if client is None:
        return {"ok": False, "error": "init manquant"}

    # Registration of the bot's key: the transaction is prepared here, its message is signed by the
    # owner's wallet in the browser (EIP-191 personal_sign), then sent with that signature.
    if cmd == "prepare_key":
        result = client.signer.SignChangePubKey(
            req["public_key"].encode("utf-8"), SignerClient.SKIP_NONCE_OFF, SignerClient.DEFAULT_NONCE, req["api_key_index"], req["account_index"]
        )
        err = decode_and_free(result.err)
        tx_info = decode_and_free(result.txInfo)
        decode_and_free(result.txHash)
        message = decode_and_free(result.messageToSign)
        if err:
            return {"ok": False, "error": err}
        return {"ok": True, "tx_type": result.txType, "tx_info": tx_info, "message": message}

    if cmd == "send_key":
        tx_info = json.loads(req["tx_info"])
        tx_info["L1Sig"] = req["signature"]
        try:
            resp = await client.send_tx(tx_type=req["tx_type"], tx_info=json.dumps(tx_info))
        except Exception as e:  # the API answers refusals with an exception
            return {"ok": False, "error": str(e).strip().split("\n")[-1]}
        return sent(resp, None)

    if cmd == "leverage":
        _, resp, err = await client.update_leverage(BTC_MARKET, SignerClient.CROSS_MARGIN_MODE, req["leverage"])
        return sent(resp, err)

    # Market order on BTC, refused by Lighter rather than filled beyond max_slippage.
    if cmd == "order":
        _, resp, err = await client.create_market_order_limited_slippage(
            market_index=BTC_MARKET,
            client_order_index=int(time.time() * 1000) % 2**47,
            base_amount=int(req["base"]),
            max_slippage=float(req["max_slippage"]),
            is_ask=bool(req["is_ask"]),
            reduce_only=bool(req.get("reduce_only", False)),
        )
        return sent(resp, err)

    return {"ok": False, "error": f"commande inconnue : {cmd}"}


async def main():
    loop = asyncio.get_running_loop()
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            break
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            answer(req_id, **(await handle(req)))
        except Exception as e:
            answer(req_id, ok=False, error=f"{type(e).__name__}: {e}")
    if client is not None:
        await client.close()


if __name__ == "__main__":
    # The SDK logs through the logging module; keep stdout for answers only.
    import logging

    logging.basicConfig(stream=sys.stderr, level=logging.WARNING)
    asyncio.run(main())
