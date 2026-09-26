import { useState } from "react";

import { canMoveFolder, type FolderNode, type FolderRow } from "../data/organisation";
import { Icon } from "./Icon";

/**
 * Organisation controls: the folder tree, the tag list and a note's own placement (§9, §10).
 *
 * Presentational on purpose — every action is a prop. The rules live in `organisation.ts` and the writes in
 * the repository, so what these components decide is only how the controls look and when they are disabled.
 *
 * Names are edited inline rather than through a prompt dialog: a dialog blocks the page, cannot be styled
 * with the rest of the interface, and cannot be driven by the browser suite.
 */

export interface FolderTreeProps {
  nodes: readonly FolderNode[];
  /** Every folder as a flat row, needed to reason about moves. */
  rows: readonly FolderRow[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onCreate: (parentId: string | null, name: string) => void;
  onRename: (id: string, name: string) => void;
  onMove: (id: string, parentId: string | null) => void;
  onDelete: (id: string) => void;
}

export function FolderTree({
  nodes,
  rows,
  selectedId,
  onSelect,
  onCreate,
  onRename,
  onMove,
  onDelete,
}: FolderTreeProps) {
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderParent, setNewFolderParent] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  const create = () => {
    const name = newFolderName.trim();
    if (name.length === 0) {
      return;
    }
    onCreate(newFolderParent, name);
    setNewFolderName("");
  };

  const renderNodes = (list: readonly FolderNode[], depth: number) =>
    list.map((node) => (
      <li key={node.id} style={{ marginLeft: `${depth * 0.75}rem` }}>
        <div className="folder-row">
          {renaming === node.id ? (
            <input
              autoFocus
              defaultValue={node.name}
              aria-label={`Rename ${node.name}`}
              onBlur={(event) => {
                const name = event.target.value.trim();
                if (name.length > 0 && name !== node.name) {
                  onRename(node.id, name);
                }
                setRenaming(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.currentTarget.blur();
                }
                if (event.key === "Escape") {
                  setRenaming(null);
                }
              }}
            />
          ) : (
            <button
              type="button"
              className={node.id === selectedId ? "selected" : undefined}
              onClick={() => onSelect(node.id === selectedId ? null : node.id)}
            >
              {node.name}
            </button>
          )}
          <button
            type="button"
            aria-label={`Rename folder ${node.name}`}
            onClick={() => setRenaming(node.id)}
          >
            <Icon name="rename" />
          </button>
          <button
            type="button"
            aria-label={`New subfolder in ${node.name}`}
            onClick={() => {
              setNewFolderParent(node.id);
              setNewFolderName("");
            }}
          >
            <Icon name="add" />
          </button>
          <button
            type="button"
            aria-label={`Delete folder ${node.name}`}
            onClick={() => onDelete(node.id)}
          >
            <Icon name="remove" />
          </button>
        </div>
        {newFolderParent === node.id && (
          <div className="folder-row" style={{ marginLeft: `${(depth + 1) * 0.75}rem` }}>
            <input
              autoFocus
              value={newFolderName}
              placeholder="Subfolder name"
              aria-label="New subfolder name"
              onChange={(event) => setNewFolderName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  create();
                }
                if (event.key === "Escape") {
                  setNewFolderParent(null);
                }
              }}
            />
            <button type="button" onClick={create}>
              Add
            </button>
          </div>
        )}
        {node.children.length > 0 && <ul>{renderNodes(node.children, depth + 1)}</ul>}
      </li>
    ));

  const selected = rows.find((row) => row.id === selectedId) ?? null;

  return (
    <section className="folders-pane">
      <h2>Folders</h2>
      <button
        type="button"
        className={selectedId === null ? "selected" : undefined}
        onClick={() => onSelect(null)}
      >
        All notes
      </button>
      <ul className="folder-tree">{renderNodes(nodes, 0)}</ul>

      <div className="folder-row">
        <input
          value={newFolderParent === null ? newFolderName : ""}
          placeholder="New folder"
          aria-label="New folder name"
          onChange={(event) => {
            setNewFolderParent(null);
            setNewFolderName(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              create();
            }
          }}
        />
        <button type="button" aria-label="Add folder" onClick={create}>
          Add
        </button>
      </div>

      {selected && (
        <label className="field">
          <span>Move “{selected.name}” to</span>
          <select
            aria-label="Move folder"
            value={selected.parentId ?? ""}
            onChange={(event) =>
              onMove(selected.id, event.target.value === "" ? null : event.target.value)
            }
          >
            <option value="">(top level)</option>
            {rows
              // The choices the server would refuse are disabled rather than offered and rejected: moving a
              // folder into its own subtree would detach that subtree from the tree.
              .filter((row) => row.id !== selected.id)
              .map((row) => (
                <option
                  key={row.id}
                  value={row.id}
                  disabled={!canMoveFolder(rows, selected.id, row.id)}
                >
                  {row.name}
                </option>
              ))}
          </select>
        </label>
      )}
    </section>
  );
}

export interface TagListProps {
  tags: readonly { id: string; name: string }[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}

export function TagList({
  tags,
  selectedId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: TagListProps) {
  const [newTagName, setNewTagName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);

  return (
    <section className="tags-pane">
      <h2>Tags</h2>
      <ul>
        {tags.map((tag) => (
          <li key={tag.id} className="folder-row">
            {renaming === tag.id ? (
              <input
                autoFocus
                defaultValue={tag.name}
                aria-label={`Rename ${tag.name}`}
                onBlur={(event) => {
                  const name = event.target.value.trim();
                  if (name.length > 0 && name !== tag.name) {
                    onRename(tag.id, name);
                  }
                  setRenaming(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.currentTarget.blur();
                  }
                  if (event.key === "Escape") {
                    setRenaming(null);
                  }
                }}
              />
            ) : (
              <button
                type="button"
                className={tag.id === selectedId ? "selected" : undefined}
                onClick={() => onSelect(tag.id === selectedId ? null : tag.id)}
              >
                {tag.name}
              </button>
            )}
            <button
              type="button"
              aria-label={`Rename tag ${tag.name}`}
              onClick={() => setRenaming(tag.id)}
            >
              <Icon name="rename" />
            </button>
            <button
              type="button"
              aria-label={`Delete tag ${tag.name}`}
              onClick={() => onDelete(tag.id)}
            >
              <Icon name="remove" />
            </button>
          </li>
        ))}
      </ul>
      <div className="folder-row">
        <input
          value={newTagName}
          placeholder="New tag"
          aria-label="New tag name"
          onChange={(event) => setNewTagName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && newTagName.trim().length > 0) {
              onCreate(newTagName.trim());
              setNewTagName("");
            }
          }}
        />
        <button
          type="button"
          aria-label="Add tag"
          onClick={() => {
            if (newTagName.trim().length > 0) {
              onCreate(newTagName.trim());
              setNewTagName("");
            }
          }}
        >
          Add
        </button>
      </div>
    </section>
  );
}

export interface NoteOrganisationProps {
  folders: readonly { id: string; name: string }[];
  tags: readonly { id: string; name: string }[];
  folderId: string | null;
  tagIds: readonly string[];
  maxTags: number;
  onFolderChange: (folderId: string | null) => void;
  onTagsChange: (tagIds: string[]) => void;
  /** Creates a tag and applies it to this note; absent when the editor cannot write tags. */
  onCreateTag?: (name: string) => void;
}

/** Where the open note lives, and which tags it carries. */
export function NoteOrganisation({
  folders,
  tags,
  folderId,
  tagIds,
  maxTags,
  onFolderChange,
  onTagsChange,
  onCreateTag,
}: NoteOrganisationProps) {
  const [adding, setAdding] = useState(false);
  const [draftName, setDraftName] = useState("");

  const toggle = (tagId: string) => {
    const next = tagIds.includes(tagId) ? tagIds.filter((id) => id !== tagId) : [...tagIds, tagId];
    onTagsChange(next);
  };

  const submitNewTag = () => {
    const name = draftName.trim();
    setAdding(false);
    setDraftName("");
    if (name.length > 0) {
      onCreateTag?.(name);
    }
  };

  return (
    <section className="metadata-bar" aria-label="Note organisation">
      {/* The folder is one chip, and the control is still a select: choosing one of a list is what a select is for,
          and the label it carries is what a screen reader and the tests both use. */}
      <label className="chip chip-field" title="Folder">
        <Icon name="folder" size={12} />
        <select
          aria-label="Note folder"
          value={folderId ?? ""}
          onChange={(event) =>
            onFolderChange(event.target.value === "" ? null : event.target.value)
          }
        >
          <option value="">No folder</option>
          {folders.map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.name}
            </option>
          ))}
        </select>
        <Icon name="collapse" size={12} />
      </label>

      <div className="chip-row" role="group" aria-label={`Tags (${tagIds.length}/${maxTags})`}>
        {tags.map((tag) => {
          const selected = tagIds.includes(tag.id);
          return (
            <label
              key={tag.id}
              className={selected ? "chip chip-toggle selected" : "chip chip-toggle"}
            >
              <input
                type="checkbox"
                checked={selected}
                // The cap is enforced by disabling what cannot be added, rather than accepting the click and dropping
                // it silently.
                disabled={!selected && tagIds.length >= maxTags}
                onChange={() => toggle(tag.id)}
              />
              <span>{tag.name}</span>
            </label>
          );
        })}

        {tags.length === 0 && !adding && <span className="muted">No tags yet</span>}

        {adding ? (
          <form
            className="chip chip-input"
            onSubmit={(event) => {
              event.preventDefault();
              submitNewTag();
            }}
          >
            <input
              aria-label="New tag for this note"
              value={draftName}
              autoFocus
              placeholder="Tag name"
              onChange={(event) => setDraftName(event.target.value)}
              onBlur={submitNewTag}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setAdding(false);
                  setDraftName("");
                }
              }}
            />
          </form>
        ) : (
          <button
            type="button"
            className="chip chip-add"
            aria-label="Add a tag to this note"
            title="Add a tag"
            onClick={() => setAdding(true)}
          >
            <Icon name="add" size={12} />
            Tag
          </button>
        )}
      </div>
    </section>
  );
}
