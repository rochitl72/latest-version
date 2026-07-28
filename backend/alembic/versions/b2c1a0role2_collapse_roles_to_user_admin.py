"""collapse roles to user + admin

Folds the old three-tier ladder (annotator < reviewer < admin) into two roles.
Every reviewer becomes an admin (reviewers gained no powers, they keep all of
them under the admin role); every annotator becomes a plain user.

Data-only migration — no schema change, the role column is already String(20).

Revision ID: b2c1a0role2
Revises: 7c3f64a18f47
Create Date: 2026-07-22
"""
from typing import Sequence, Union

from alembic import op

revision: str = "b2c1a0role2"
down_revision: Union[str, None] = "7c3f64a18f47"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # reviewer → admin, annotator → user. Anything unexpected is left alone.
    op.execute("UPDATE users SET role = 'admin' WHERE role = 'reviewer'")
    op.execute("UPDATE users SET role = 'user' WHERE role = 'annotator'")


def downgrade() -> None:
    # Best-effort reverse: plain users become annotators again. Former reviewers
    # cannot be told apart from born admins after the collapse, so they stay
    # admin — the downgrade is intentionally lossy in that direction.
    op.execute("UPDATE users SET role = 'annotator' WHERE role = 'user'")
