# One-click launch (Mac)

> ⚠️ **HISTORICAL — SUPERSEDED. Not a description of the current system.**
>
> This plan was written for an earlier design and is kept only as a record of how
> the project got here. Since it was written:
>
> * live multi-user co-editing of one image (WebSocket, presence, image locks)
>   was **removed**;
> * many-users-per-project (`project_members`) was replaced by **one assigned
>   user per project**;
> * the one-click desktop launchers were dropped in favour of a **Docker
>   deployment on a server**;
> * ML auto-labelling (SAM / GroundingDINO) was **removed**.
>
> For how the system actually works now, read `../ARCHITECTURE.md` and
> `../DATA_FLOW.md`.


## Desktop & Dock (recommended)

**`RBG Annotation Studio.app`** should be on your **Desktop** and in the **Dock**.

- **Desktop (home screen):** double-click `RBG Annotation Studio` on the Desktop  
- **Dock:** click the same icon in the Dock  

To re-pin after moving the project folder:

```bash
cd ~/Downloads/lableRBG/annoforge
./scripts/pin-to-dock-and-desktop.sh
```

## Or use the `.command` file

1. Open Finder → `Downloads/lableRBG/annoforge/`
2. Double-click **`Start RBG Annotation Studio.command`**
3. Terminal opens, servers start, **Safari/Chrome opens** to http://localhost:5173
4. You can **close the Terminal window** — the app keeps running

## Double-click to stop

**`Stop RBG Annotation Studio.command`**

## First launch only

The first time may take **5–15 minutes** (Python packages + SAM model download). Later launches are ~10 seconds.

## Your data (always local)

| Item | Path |
|------|------|
| Database | `backend/annoforge.db` |
| Images | `backend/storage/` |
| Logs | `logs/` |

Copy the whole `annoforge` folder to back up or move to another Mac.

## If macOS blocks the `.command` file

Right-click → **Open** → **Open** (first time only),  
or run in Terminal:

```bash
cd ~/Downloads/lableRBG/annoforge
chmod +x "Start RBG Annotation Studio.command"
./scripts/start-annoforge.sh
```

## Optional: Dock shortcut

Drag **`Start RBG Annotation Studio.command`** to the Dock (right side) for a one-click icon.
