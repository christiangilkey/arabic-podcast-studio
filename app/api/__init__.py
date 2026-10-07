"""HTTP API routers."""

from fastapi import APIRouter

from . import definer, episodes, feeds, search, system, vocab

router = APIRouter(prefix="/api")
for module in (feeds, episodes, search, vocab, definer, system):
    router.include_router(module.router)
