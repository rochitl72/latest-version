"""Application settings.

Every value below can be overridden with an environment variable of the same
name, or by a `.env` file next to the backend folder. See `.env.example`.
"""
import secrets
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# Credentials the app ships with. Fine for a local demo, unsafe on a network —
# `main.py` logs a warning at startup if these are still in use.
DEFAULT_USERNAME = "admin"
DEFAULT_PASSWORD = "123"

# A second, ordinary account seeded alongside the admin purely for local
# testing (so you can immediately try the app as a non-admin without first
# creating someone through the admin UI). Seeding is idempotent — see
# `db/bootstrap.py` — and only ever creates the row if that username doesn't
# already exist, so renaming/deleting it afterward sticks.
DEFAULT_TEST_USERNAME = "test"
DEFAULT_TEST_PASSWORD = "123"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # ─── Paths ───────────────────────────────────────────────────────
    BASE_DIR: Path = Path(__file__).resolve().parent.parent.parent
    STORAGE_DIR: Path = BASE_DIR / "storage"

    # ─── Database (PostgreSQL only) ──────────────────────────────────
    # Format: postgresql+asyncpg://user:password@host:5432/dbname
    POSTGRES_USER: str = "annoforge"
    POSTGRES_PASSWORD: str = "annoforge"
    POSTGRES_HOST: str = "localhost"
    POSTGRES_PORT: int = 5432
    POSTGRES_DB: str = "annoforge"

    # Set this to override the pieces above entirely — e.g. a managed-database
    # connection string. Must be a PostgreSQL URL
    # (postgresql+asyncpg://user:pass@host:5432/dbname); PostgreSQL is the only
    # supported database.
    DATABASE_URL: str = ""

    # Connection pool. Defaults suit a small team; raise for dozens of
    # concurrent users (and consider PgBouncer in front past that).
    DB_POOL_SIZE: int = 20
    DB_MAX_OVERFLOW: int = 40

    # ─── Environment ─────────────────────────────────────────────────
    # "production" makes unsafe defaults fatal instead of merely warned:
    # an unset SECRET_KEY or the built-in admin password will refuse to boot.
    ENVIRONMENT: str = "development"

    # ─── Server ──────────────────────────────────────────────────────
    HOST: str = "0.0.0.0"
    PORT: int = 8000

    # Origins allowed to call the API from a browser. Only needed when the
    # frontend is served from a DIFFERENT origin than the backend; the
    # production build is served by this same process, so same-origin
    # requests need no entry here.
    CORS_ORIGINS: list[str] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]

    # ─── Authentication ──────────────────────────────────────────────
    # Set AUTH_ENABLED=false only for local development.
    AUTH_ENABLED: bool = True

    # Users now live in the database. These seed the first admin account on an
    # empty database so there is always a way in; after that, manage accounts
    # through the admin UI. Changing them later does not alter existing users.
    BOOTSTRAP_ADMIN_USERNAME: str = DEFAULT_USERNAME
    BOOTSTRAP_ADMIN_PASSWORD: str = DEFAULT_PASSWORD
    BOOTSTRAP_ADMIN_EMAIL: str = "admin@example.com"

    # Optional second seeded account for quick local testing as a plain user.
    # Defaults to FALSE so a deployment can never accidentally ship a
    # well-known `test`/`123` login. Set SEED_TEST_USER=true in your local
    # .env when you want it for development.
    SEED_TEST_USER: bool = False
    BOOTSTRAP_TEST_USERNAME: str = DEFAULT_TEST_USERNAME
    BOOTSTRAP_TEST_PASSWORD: str = DEFAULT_TEST_PASSWORD

    # Whether new users may sign themselves up. When false (the default), only
    # an admin can create accounts.
    ALLOW_SELF_REGISTRATION: bool = False

    # NOTE: there are deliberately NO password rules in this application —
    # no minimum length, no complexity, no reuse history, no expiry. Any
    # string is accepted, including an empty one. Account security rests on
    # the admin choosing sensible passwords.

    # Signs JWTs. Generated per-process if unset, which invalidates existing
    # tokens on every restart — set it explicitly in production.
    SECRET_KEY: str = ""
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 12  # 12 hours

    # Set true once you serve over HTTPS, so the auth cookie is never sent
    # over plain HTTP. Left false by default so local http:// still works.
    COOKIE_SECURE: bool = False

    # ─── Uploads ─────────────────────────────────────────────────────
    MAX_UPLOAD_MB: int = 50
    MAX_FILES_PER_UPLOAD: int = 500
    ALLOWED_IMAGE_EXTENSIONS: set[str] = {
        ".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff",
    }

    # ─── Exports ─────────────────────────────────────────────────────
    # Where "Export to Downloads" writes. Defaults to the user's Downloads
    # folder for desktop use; on a server point this at a real data volume.
    EXPORT_DIR: Path = Path.home() / "Downloads"

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.STORAGE_DIR.mkdir(exist_ok=True, parents=True)
        if not self.DATABASE_URL:
            self.DATABASE_URL = (
                f"postgresql+asyncpg://{self.POSTGRES_USER}:{self.POSTGRES_PASSWORD}"
                f"@{self.POSTGRES_HOST}:{self.POSTGRES_PORT}/{self.POSTGRES_DB}"
            )
        if not self.SECRET_KEY:
            if self.is_production:
                raise RuntimeError(
                    "SECRET_KEY must be set when ENVIRONMENT=production. "
                    "A per-process random key would log everyone out on every "
                    "restart and differ across workers. Generate one with:\n"
                    "  python -c \"import secrets; print(secrets.token_urlsafe(32))\""
                )
            # Development only: a throwaway key, regenerated each start.
            self.SECRET_KEY = secrets.token_urlsafe(32)
        if self.is_production and self.using_default_credentials:
            raise RuntimeError(
                "The built-in bootstrap admin password is still in use with "
                "ENVIRONMENT=production. Set BOOTSTRAP_ADMIN_PASSWORD to a real "
                "secret before deploying."
            )

    @property
    def is_production(self) -> bool:
        return self.ENVIRONMENT.strip().lower() == "production"

    @property
    def sync_database_url(self) -> str:
        """Alembic runs synchronously — swap the async driver out for psycopg."""
        return self.DATABASE_URL.replace("+asyncpg", "")

    @property
    def max_upload_bytes(self) -> int:
        return self.MAX_UPLOAD_MB * 1024 * 1024

    @property
    def using_default_credentials(self) -> bool:
        return (
            self.BOOTSTRAP_ADMIN_USERNAME == DEFAULT_USERNAME
            and self.BOOTSTRAP_ADMIN_PASSWORD == DEFAULT_PASSWORD
        )



settings = Settings()
