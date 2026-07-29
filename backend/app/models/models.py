"""SQLAlchemy ORM models.

PostgreSQL-only. JSON columns are JSONB (binary, indexable) and timestamps are
timezone-aware.
"""
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean, DateTime, Float, ForeignKey, Index, Integer, String, Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.database import Base

# JSONB on Postgres: binary and indexable.
JSONType = JSONB


def utcnow() -> datetime:
    """Timezone-aware UTC. `datetime.utcnow` is naive and deprecated in 3.12+."""
    return datetime.now(timezone.utc)


TimestampTZ = DateTime(timezone=True)


# ─── Identity ────────────────────────────────────────────────────────
class Role:
    """Global roles. Two tiers: a plain USER, and an ADMIN who can do everything.

    An earlier three-tier ladder (annotator < reviewer < admin) was collapsed:
    everything the reviewer role could do now belongs to admin.
    """

    USER = "user"
    ADMIN = "admin"

    ALL = (USER, ADMIN)
    # Rank lets permission checks ask "at least admin?" without listing roles.
    RANK = {USER: 1, ADMIN: 2}


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(80), unique=True, index=True, nullable=False)
    email: Mapped[str] = mapped_column(String(255), default="")
    full_name: Mapped[str] = mapped_column(String(200), default="")
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[str] = mapped_column(String(20), default=Role.USER, index=True)

    # Account status, chosen by an admin. We never hard-delete a user (that would
    # orphan their authored annotations); instead an admin flips this between
    # "active" and "deactivated". A deactivated user is refused at login with a
    # clear message. `is_active` below is a convenience wrapper over this so the
    # many places that read a boolean keep working.
    status: Mapped[str] = mapped_column(String(20), default="active", index=True)

    # Set on the seeded admin (and any admin-created account) so the UI can force
    # a password change on first sign-in. Cleared once the password is changed.
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(TimestampTZ, default=utcnow)
    last_login_at: Mapped[datetime | None] = mapped_column(TimestampTZ, nullable=True)

    # Status values.
    STATUS_ACTIVE = "active"
    STATUS_DEACTIVATED = "deactivated"

    @property
    def is_active(self) -> bool:
        """True unless an admin has deactivated the account. Reads the `status`
        column so existing boolean call sites (login checks, serialisers) keep
        working after the switch from a boolean column to a status string."""
        return self.status == self.STATUS_ACTIVE

    @is_active.setter
    def is_active(self, value: bool) -> None:
        self.status = self.STATUS_ACTIVE if value else self.STATUS_DEACTIVATED

    @property
    def is_admin(self) -> bool:
        return self.role == Role.ADMIN

    @property
    def can_review(self) -> bool:
        """Review powers (approve/reject, edit others' work) now belong to admin.

        Kept as a named property so the many call sites reading "can this user
        review?" stay readable; it simply means "is an admin" under two roles.
        """
        return self.role == Role.ADMIN


# ─── Projects & data ─────────────────────────────────────────────────
class Project(Base):
    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="")
    task_type: Mapped[str] = mapped_column(String(50), default="detection")
    # projects → dataset_versions → projects is a genuine cycle. use_alter
    # makes this constraint a follow-up ALTER TABLE instead of part of the
    # CREATE, so the tables can be created in a valid order. Without it
    # Postgres fails the first migration on a forward reference.
    active_version_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey(
            "dataset_versions.id",
            ondelete="SET NULL",
            use_alter=True,
            name="fk_projects_active_version",
        ),
        nullable=True,
    )
    created_by: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    # The single non-admin user this project is assigned to. One user per
    # project (admins always have access regardless). Nullable: a project can
    # exist unassigned, but it must be assigned before images can be uploaded,
    # because a project's files live under its assigned user's folder on disk.
    # ON DELETE SET NULL is defensive only — users are deactivated, not deleted.
    assigned_user_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )

    created_at: Mapped[datetime] = mapped_column(TimestampTZ, default=utcnow)

    images: Mapped[list["Image"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    labels: Mapped[list["Label"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    versions: Mapped[list["DatasetVersion"]] = relationship(
        back_populates="project",
        cascade="all, delete-orphan",
        foreign_keys="DatasetVersion.project_id",
    )


class DatasetVersion(Base):
    __tablename__ = "dataset_versions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    version_number: Mapped[int] = mapped_column(Integer, default=1)
    parent_version_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("dataset_versions.id", ondelete="SET NULL"), nullable=True
    )
    is_frozen: Mapped[bool] = mapped_column(Boolean, default=False)
    created_by: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(TimestampTZ, default=utcnow)

    project: Mapped[Project] = relationship(
        back_populates="versions", foreign_keys=[project_id]
    )


class Label(Base):
    __tablename__ = "labels"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    color: Mapped[str] = mapped_column(String(20), default="#ffffff")
    shortcut: Mapped[str] = mapped_column(String(10), default="")
    keypoint_names: Mapped[list | None] = mapped_column(JSONType, nullable=True)
    skeleton_edges: Mapped[list | None] = mapped_column(JSONType, nullable=True)
    created_at: Mapped[datetime] = mapped_column(TimestampTZ, default=utcnow)

    project: Mapped[Project] = relationship(back_populates="labels")


class Image(Base):
    __tablename__ = "images"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    version_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("dataset_versions.id", ondelete="CASCADE"), nullable=True
    )
    filename: Mapped[str] = mapped_column(String(500), nullable=False)
    # Absolute path to the original image file on disk. The bytes live on disk
    # (under the assigned user's folder); only this path is stored in the DB.
    storage_path: Mapped[str] = mapped_column(String(500), nullable=False)
    # Absolute path to this image's annotations.json backup file on disk. The
    # authoritative annotations are still the rows in the `annotations` table
    # (so dashboards/exports stay fast); this file is a continuously-synced
    # backup written on every annotation change. Null until first annotated.
    annotations_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    width: Mapped[int] = mapped_column(Integer)
    height: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(30), default="unannotated", index=True)
    split: Mapped[str] = mapped_column(String(10), default="train")
    sequence_id: Mapped[str] = mapped_column(String(64), default="")
    frame_index: Mapped[int] = mapped_column(Integer, default=0)

    # Review outcome, set by a reviewer or admin.
    reviewed_by: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    reviewed_at: Mapped[datetime | None] = mapped_column(TimestampTZ, nullable=True)
    review_note: Mapped[str] = mapped_column(Text, default="")

    created_at: Mapped[datetime] = mapped_column(TimestampTZ, default=utcnow)

    project: Mapped[Project] = relationship(back_populates="images")
    annotations: Mapped[list["Annotation"]] = relationship(
        back_populates="image", cascade="all, delete-orphan"
    )

    __table_args__ = (
        Index("ix_images_project_status", "project_id", "status"),
    )


class Annotation(Base):
    __tablename__ = "annotations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    image_id: Mapped[int] = mapped_column(
        ForeignKey("images.id", ondelete="CASCADE"), index=True
    )
    label_id: Mapped[int] = mapped_column(ForeignKey("labels.id", ondelete="CASCADE"))
    type: Mapped[str] = mapped_column(String(20))
    geometry: Mapped[dict] = mapped_column(JSONType)
    confidence: Mapped[float] = mapped_column(Float, default=1.0)
    source: Mapped[str] = mapped_column(String(20), default="manual")

    # Ownership: annotators may only modify their own work.
    created_by: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    updated_by: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(TimestampTZ, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        TimestampTZ, default=utcnow, onupdate=utcnow
    )

    image: Mapped[Image] = relationship(back_populates="annotations")
    label: Mapped[Label] = relationship()


class ActivityLog(Base):
    """Append-only audit trail. Every mutation writes one row."""

    __tablename__ = "activity_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # Denormalised so the feed still reads correctly after a user is deleted.
    username: Mapped[str] = mapped_column(String(80), default="")

    action: Mapped[str] = mapped_column(String(50), index=True)
    project_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    image_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    annotation_id: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Free-form context: before/after geometry, old/new status, and so on.
    details: Mapped[dict | None] = mapped_column(JSONType, nullable=True)

    created_at: Mapped[datetime] = mapped_column(TimestampTZ, default=utcnow, index=True)

    __table_args__ = (
        Index("ix_activity_project_created", "project_id", "created_at"),
        Index("ix_activity_user_created", "user_id", "created_at"),
    )


class Action:
    """Canonical action names written to ActivityLog.action."""

    LOGIN = "login"
    LOGOUT = "logout"
    USER_CREATE = "user.create"
    USER_UPDATE = "user.update"
    USER_DEACTIVATE = "user.deactivate"
    USER_ACTIVATE = "user.activate"
    # Permanent account removal. Distinct from USER_DEACTIVATE: the row is
    # gone and their project files have moved to orphan_projects/.
    USER_DELETE = "user.delete"
    # A project has a single assigned user now; assigning/clearing that user.
    PROJECT_ASSIGN = "project.assign"
    PROJECT_UNASSIGN = "project.unassign"
    # Legacy multi-member actions, kept only so old audit rows still render.
    MEMBER_ADD = "project.member_add"
    MEMBER_REMOVE = "project.member_remove"
    PROJECT_CREATE = "project.create"
    PROJECT_DELETE = "project.delete"
    LABEL_CREATE = "label.create"
    LABEL_DELETE = "label.delete"
    IMAGE_UPLOAD = "image.upload"
    IMAGE_DELETE = "image.delete"
    IMAGE_ASSIGN = "image.assign"
    IMAGE_STATUS = "image.status_change"
    ANNOTATION_CREATE = "annotation.create"
    ANNOTATION_UPDATE = "annotation.update"
    ANNOTATION_DELETE = "annotation.delete"
    REVIEW_APPROVE = "review.approve"
    REVIEW_REJECT = "review.reject"
    REVIEW_REQUEST = "review.request"
    VERSION_CREATE = "version.create"
    EXPORT = "export"
