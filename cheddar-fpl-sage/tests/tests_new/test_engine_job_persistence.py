import json

from backend.services.engine_service import AnalysisJob, EngineService


class FakeRedis:
    def __init__(self):
        self.store = {}
        self.ttl_by_key = {}

    def setex(self, key, ttl_seconds, payload):
        self.store[key] = payload
        self.ttl_by_key[key] = ttl_seconds

    def get(self, key):
        return self.store.get(key)


def test_configure_redis_enforces_minimum_ttl():
    service = EngineService()
    fake_redis = FakeRedis()

    service.configure_redis(fake_redis, job_ttl_seconds=30)

    assert service._redis is fake_redis
    assert service._job_ttl_seconds == 3600


def test_create_analysis_persists_job_when_redis_configured():
    service = EngineService()
    fake_redis = FakeRedis()
    service.configure_redis(fake_redis, job_ttl_seconds=7200)

    job = service.create_analysis(team_id=711511, gameweek=25, overrides={"source": "test"})

    key = service._job_key(job.analysis_id)
    assert key in fake_redis.store
    assert fake_redis.ttl_by_key[key] == 7200

    payload = json.loads(fake_redis.store[key])
    assert payload["analysis_id"] == job.analysis_id
    assert payload["team_id"] == 711511
    assert payload["status"] == "queued"


def test_get_job_restores_state_from_redis_when_memory_cleared():
    service = EngineService()
    fake_redis = FakeRedis()
    service.configure_redis(fake_redis, job_ttl_seconds=7200)

    job = service.create_analysis(team_id=12345)
    job.status = "analyzing"
    job.progress = 55.0
    job.phase = "transfer_optimization"
    service._persist_job(job)

    service._jobs.clear()

    restored = service.get_job(job.analysis_id)
    assert restored is not None
    assert restored.analysis_id == job.analysis_id
    assert restored.team_id == 12345
    assert restored.status == "analyzing"
    assert restored.progress == 55.0
    assert restored.phase == "transfer_optimization"
    assert job.analysis_id in service._progress_callbacks


def test_get_job_prefers_in_memory_state_over_redis_snapshot():
    service = EngineService()
    fake_redis = FakeRedis()
    service.configure_redis(fake_redis, job_ttl_seconds=7200)

    job = service.create_analysis(team_id=1001)
    key = service._job_key(job.analysis_id)
    stale = AnalysisJob(job.analysis_id, team_id=1001)
    stale.status = "queued"
    fake_redis.setex(key, 7200, json.dumps(stale.to_dict()))

    job.status = "complete"
    in_memory = service.get_job(job.analysis_id)
    assert in_memory is not None
    assert in_memory.status == "complete"


def test_notify_progress_updates_and_persists_job_state():
    service = EngineService()
    fake_redis = FakeRedis()
    service.configure_redis(fake_redis, job_ttl_seconds=7200)

    job = service.create_analysis(team_id=2222)
    service._notify_progress(job.analysis_id, 30.0, "injury_analysis")

    cached = json.loads(fake_redis.store[service._job_key(job.analysis_id)])
    assert cached["progress"] == 30.0
    assert cached["phase"] == "injury_analysis"


def test_persist_failures_do_not_break_job_creation():
    service = EngineService()

    class FailingRedis:
        def setex(self, *_args, **_kwargs):
            raise RuntimeError("boom")

        def get(self, *_args, **_kwargs):
            return None

    service.configure_redis(FailingRedis(), job_ttl_seconds=7200)
    job = service.create_analysis(team_id=999)

    assert job is not None
    assert job.analysis_id in service._jobs


def test_load_invalid_json_from_redis_returns_none():
    service = EngineService()
    fake_redis = FakeRedis()
    service.configure_redis(fake_redis, job_ttl_seconds=7200)
    fake_redis.setex(service._job_key("bad-json"), 7200, "not json")

    restored = service.get_job("bad-json")
    assert restored is None
