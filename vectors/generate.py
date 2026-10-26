#!/usr/bin/env python3
# MIT. Independent normative vectors: Python hashlib/hmac, no package code imports.
import hashlib
import hmac
import json
from pathlib import Path

CTX_COMMIT = b"tavlarena-dice-commit-v1"
CTX_ROLL = b"tavlarena-dice-roll-v1"
GAME = "00010203-0405-4607-8809-0a0b0c0d0e0f"
PLAYERS = ["10111213-1415-4617-9819-1a1b1c1d1e1f", "20212223-2425-4627-a829-2a2b2c2d2e2f"]
CONTRIBUTIONS = [bytes(range(32, 64)), bytes(range(64, 96))]
SETTINGS = {"rulesVersion": "2026.10.0", "rules": {"variant": "tavla", "openingReroll": True, "winnerStarts": True, "matchLength": 5, "matchFormat": "points", "cube": False, "crawford": False, "triple": False, "homeHitAndRun": True, "forcedBearoff": False, "jacoby": False, "beaver": False}}

def canonical(value):
    if isinstance(value, dict):
        keys = sorted(value, key=lambda s: s.encode("utf-16-be"))
        return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + canonical(value[k]) for k in keys) + "}"
    if isinstance(value, list):
        return "[" + ",".join(canonical(v) for v in value) + "]"
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)

def uuid(value):
    return bytes.fromhex(value.replace("-", ""))

def block(seed, counter, number=0):
    message = CTX_ROLL + uuid(GAME) + b"".join(CONTRIBUTIONS) + counter.to_bytes(4, "big") + number.to_bytes(4, "big")
    return hmac.new(seed, message, hashlib.sha256).digest()

def dice(seed, counter):
    result = []
    number = 0
    while len(result) < 2:
        for byte in block(seed, counter, number):
            if byte < 252:
                result.append(byte % 6 + 1)
                if len(result) == 2:
                    break
        number += 1
    return result

def make(name, seed):
    encoded = canonical(SETTINGS).encode("utf-8")
    settings_hash = hashlib.sha256(encoded).digest()
    commitment = hashlib.sha256(CTX_COMMIT + uuid(GAME) + settings_hash + b"".join(map(uuid, PLAYERS)) + seed).hexdigest()
    rolls = [{"index": i, "dice": dice(seed, i), "kind": "opening" if i == 0 else "reroll" if i == 1 else "discard" if i == 3 else "turn"} for i in range(8)]
    return {"name": name, "canonicalSettings": encoded.decode(), "settingsHash": settings_hash.hex(), "blocks": [{"counter": i, "block": 0, "hmac": block(seed, i).hex()} for i in range(8)] + [{"counter": 4294967295, "block": 4294967295, "hmac": block(seed, 4294967295, 4294967295).hex()}], "proof": {"version": 1, "gameId": GAME, "playerIds": PLAYERS, "settings": SETTINGS, "commitment": commitment, "contributions": [c.hex() for c in CONTRIBUTIONS], "seed": seed.hex(), "rolls": rolls}}

rejection_seed = next(i.to_bytes(32, "big") for i in range(10000) if block(i.to_bytes(32, "big"), 0)[0] >= 252)
tie_seed = next(i.to_bytes(32, "big") for i in range(10000) if len(set(dice(i.to_bytes(32, "big"), 0))) == 1)
vectors = {"format": "tavlarena-dice-v1", "generatedBy": "Python standard-library hashlib/hmac independent implementation in generate.py", "canonical": [{"input": {"z": "İı", "\ue000": "BMP", "\U00010000": "supplementary", "a": [None, True, 5, "\n"]}, "expected": canonical({"z": "İı", "\ue000": "BMP", "\U00010000": "supplementary", "a": [None, True, 5, "\n"]})}], "cases": [make("sequential-byte-seed", bytes(range(32))), make("first-byte-rejected", rejection_seed), make("tied-opening", tie_seed)]}
Path(__file__).with_name("v1.json").write_text(json.dumps(vectors, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
