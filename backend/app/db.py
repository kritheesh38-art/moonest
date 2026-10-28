import logging

from motor.motor_asyncio import AsyncIOMotorClient

from . import config

_client = None
db = None  # the real database
_sandbox = None  # demo mode's throwaway in-memory copy
SANDBOX_SKIP = {"locations"}  # old GPS trails aren't needed in the copy


def connect(url: str | None = None):
    """Connect to MongoDB. `mongomock://` uses an in-memory DB (tests / quick demos)."""
    global _client, db, _sandbox
    _sandbox = None
    url = url or config.MONGO_URL
    if url.startswith("mongomock://"):
        from mongomock_motor import AsyncMongoMockClient

        _client = AsyncMongoMockClient()
    else:
        _client = AsyncIOMotorClient(url)
    db = _client[config.DB_NAME]
    return db


def get_db():
    """The database requests use: the in-memory copy while demo mode is on, otherwise the real one."""
    if db is None:
        connect()
    return _sandbox if _sandbox is not None and config.DEMO_MODE else db


def real_db():
    if db is None:
        connect()
    return db


async def open_sandbox():
    """A fresh in-memory copy of the real data. Demo mode works on it, so nothing done in demo mode
    is ever saved; switching demo mode off (or a restart) throws it away."""
    global _sandbox
    from mongomock_motor import AsyncMongoMockClient

    sb = AsyncMongoMockClient()[config.DB_NAME]
    real = real_db()
    for name in await real.list_collection_names():
        if name not in SANDBOX_SKIP and (docs := [d async for d in real[name].find({})]):
            await sb[name].insert_many(docs)
    await ensure_indexes(sb)
    _sandbox = sb
    return sb


def close_sandbox():
    global _sandbox
    _sandbox = None


async def ensure_indexes(target=None):
    """Create indexes; a problem with one (e.g. duplicate old data) is logged and never stops the app."""
    d = _SafeIndexes(target if target is not None else real_db())
    await d.users.create_index("id", unique=True)
    await d.users.create_index("phone", unique=True, sparse=True)
    await d.products.create_index("id", unique=True)
    await d.orders.create_index([("user_id", 1), ("created_at", -1)])
    await d.subscriptions.create_index("user_id")
    await d.deliveries.create_index([("date", 1), ("slot", 1), ("agent_id", 1)])
    await d.deliveries.create_index([("kind", 1), ("ref_id", 1), ("date", 1)])
    await d.wallet_ledger.create_index([("user_id", 1), ("created_at", -1)])
    await d.cod_ledger.create_index("user_id")
    await d.locations.create_index([("trip_id", 1), ("ts", -1)])
    await d.notifications.create_index([("user_id", 1), ("created_at", -1)])
    await d.route_runs.create_index("date", unique=True)
    await d.push_subs.create_index("endpoint", unique=True)
    await d.push_subs.create_index("user_id")
    await d.reminder_runs.create_index("date", unique=True)
    # one account per phone / email / admin username (sparse: accounts may lack any of them)
    await d.users.create_index("email", unique=True, sparse=True)
    await d.users.create_index("username", unique=True, sparse=True)


class _SafeIndexes:
    """Wraps the db so each create_index failure is logged instead of raised."""

    def __init__(self, db):
        self._db = db

    def __getattr__(self, name):
        coll = self._db[name]

        class _C:
            async def create_index(self, *a, **k):
                try:
                    return await coll.create_index(*a, **k)
                except Exception as e:  # noqa: BLE001
                    logging.getLogger("moonest.db").warning("Index %s on %s not created: %s", a, name, e)
        return _C()
