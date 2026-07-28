"""single user per project, user status, per-user storage columns

Moves the app from the multi-user (project_members) model to a single assigned
user per project, and from a boolean is_active to a status column. Also adds the
per-user file-storage path column and removes per-image assignment + locks.

Steps (order matters — backfill before dropping):
  1. projects.assigned_user_id  (backfilled from the earliest project_members row)
  2. drop project_members
  3. users.status               (backfilled from is_active) then drop is_active
  4. images.annotations_path    (new; backup-file path)
  5. drop images.assigned_to / assigned_at
  6. drop image_locks

Revision ID: e5f4d3single5
Revises: d4e3c2mem4
Create Date: 2026-07-24
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "e5f4d3single5"
down_revision: Union[str, None] = "d4e3c2mem4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()

    # 1. projects.assigned_user_id, backfilled from the earliest membership.
    op.add_column(
        "projects",
        sa.Column("assigned_user_id", sa.Integer(), nullable=True),
    )
    op.create_index(
        "ix_projects_assigned_user_id", "projects", ["assigned_user_id"]
    )
    op.create_foreign_key(
        "fk_projects_assigned_user",
        "projects", "users",
        ["assigned_user_id"], ["id"],
        ondelete="SET NULL",
    )
    # Collapse each project's members to its earliest-added member.
    bind.execute(sa.text(
        """
        UPDATE projects SET assigned_user_id = sub.user_id
        FROM (
            SELECT DISTINCT ON (project_id) project_id, user_id
            FROM project_members
            ORDER BY project_id, added_at ASC, id ASC
        ) AS sub
        WHERE projects.id = sub.project_id
        """
    ))

    # 2. Drop the now-unused membership table.
    op.drop_index("ix_project_members_user_id", table_name="project_members")
    op.drop_index("ix_project_members_project_id", table_name="project_members")
    op.drop_table("project_members")

    # 3. users.status, backfilled from is_active, then drop is_active.
    op.add_column(
        "users",
        sa.Column("status", sa.String(length=20), nullable=False,
                  server_default="active"),
    )
    op.create_index("ix_users_status", "users", ["status"])
    bind.execute(sa.text(
        "UPDATE users SET status = CASE WHEN is_active THEN 'active' "
        "ELSE 'deactivated' END"
    ))
    op.drop_column("users", "is_active")

    # 4. images.annotations_path.
    op.add_column(
        "images",
        sa.Column("annotations_path", sa.String(length=500), nullable=True),
    )

    # 5. Drop per-image assignment.
    op.drop_index("ix_images_assigned_to", table_name="images")
    op.drop_column("images", "assigned_at")
    op.drop_column("images", "assigned_to")

    # 6. Drop image locks.
    op.drop_index("ix_image_locks_image_id", table_name="image_locks")
    op.drop_table("image_locks")


def downgrade() -> None:
    # Recreate the dropped structures (data is not restored).
    op.create_table(
        "image_locks",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("image_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("acquired_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("heartbeat_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["image_id"], ["images.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("image_id", name="uq_image_lock"),
    )
    op.create_index("ix_image_locks_image_id", "image_locks", ["image_id"], unique=True)

    op.add_column("images", sa.Column("assigned_to", sa.Integer(), nullable=True))
    op.add_column("images", sa.Column("assigned_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index("ix_images_assigned_to", "images", ["assigned_to"])
    op.drop_column("images", "annotations_path")

    op.add_column(
        "users",
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    op.execute("UPDATE users SET is_active = (status = 'active')")
    op.drop_index("ix_users_status", table_name="users")
    op.drop_column("users", "status")

    op.create_table(
        "project_members",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("project_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("added_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("added_by", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["added_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("project_id", "user_id", name="uq_project_member"),
    )
    op.create_index("ix_project_members_project_id", "project_members", ["project_id"])
    op.create_index("ix_project_members_user_id", "project_members", ["user_id"])
    # Seed one membership per assigned project.
    op.execute(
        "INSERT INTO project_members (project_id, user_id, added_at) "
        "SELECT id, assigned_user_id, now() FROM projects "
        "WHERE assigned_user_id IS NOT NULL"
    )

    op.drop_constraint("fk_projects_assigned_user", "projects", type_="foreignkey")
    op.drop_index("ix_projects_assigned_user_id", table_name="projects")
    op.drop_column("projects", "assigned_user_id")
