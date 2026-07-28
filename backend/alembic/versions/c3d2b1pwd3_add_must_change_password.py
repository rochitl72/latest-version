"""add users.must_change_password

Lets the app force a password change on first sign-in (used for the seeded
admin that ships with a default password).

Revision ID: c3d2b1pwd3
Revises: b2c1a0role2
Create Date: 2026-07-22
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "c3d2b1pwd3"
down_revision: Union[str, None] = "b2c1a0role2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "must_change_password",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )


def downgrade() -> None:
    op.drop_column("users", "must_change_password")
