import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { v4 as uuid } from 'uuid';
import { useData } from '../state/DataProvider';
import type { Project } from '../types';
import { Button, ConfirmDialog, Field, Input, Modal, useToast, type MenuItem } from './ui';
import { IconArrowRight, IconCopy, IconEdit, IconTrash } from './ui/icons';

/** Shared open / rename / duplicate / delete behaviour for project cards. */
export function useProjectActions() {
  const navigate = useNavigate();
  const toast = useToast();
  const { saveProjects, settings } = useData();
  const [renaming, setRenaming] = useState<Project | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleting, setDeleting] = useState<Project | null>(null);

  const remove = async (project: Project) => {
    await saveProjects((all) => all.filter((p) => p.id !== project.id));
    setDeleting(null);
    toast('Project deleted', { description: project.name });
  };

  const duplicate = async (project: Project) => {
    const now = new Date().toISOString();
    const copy: Project = { ...structuredClone(project), id: uuid(), name: `${project.name} (copy)`, createdAt: now, updatedAt: now };
    await saveProjects((all) => [...all, copy]);
    toast('Project duplicated', { description: copy.name });
  };

  const itemsFor = (project: Project): Array<MenuItem | 'divider'> => [
    { label: 'Open', icon: <IconArrowRight size={16} />, onSelect: () => navigate(`/projects/${project.id}`) },
    {
      label: 'Rename',
      icon: <IconEdit size={16} />,
      onSelect: () => {
        setRenameValue(project.name);
        setRenaming(project);
      },
    },
    { label: 'Duplicate', icon: <IconCopy size={16} />, onSelect: () => duplicate(project) },
    'divider',
    {
      label: 'Delete',
      icon: <IconTrash size={16} />,
      danger: true,
      onSelect: () => (settings.confirmBeforeDelete ? setDeleting(project) : remove(project)),
    },
  ];

  const submitRename = async () => {
    if (!renaming || !renameValue.trim()) return;
    const name = renameValue.trim();
    await saveProjects((all) => all.map((p) => (p.id === renaming.id ? { ...p, name, updatedAt: new Date().toISOString() } : p)));
    setRenaming(null);
    toast('Project renamed');
  };

  const dialogs = (
    <>
      <Modal
        open={Boolean(renaming)}
        onClose={() => setRenaming(null)}
        title="Rename project"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={submitRename} disabled={!renameValue.trim()}>
              Rename
            </Button>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitRename();
          }}
        >
          <Field label="Project name" htmlFor="rename-project">
            <Input id="rename-project" data-autofocus value={renameValue} onChange={(e) => setRenameValue(e.target.value)} />
          </Field>
        </form>
      </Modal>
      <ConfirmDialog
        open={Boolean(deleting)}
        title="Delete this project?"
        description={
          <>
            <span className="font-medium text-ink">{deleting?.name}</span> and its sequence, comments and versions will be removed
            permanently. Source media files on disk are not touched.
          </>
        }
        confirmLabel="Delete project"
        destructive
        onConfirm={() => deleting && remove(deleting)}
        onCancel={() => setDeleting(null)}
      />
    </>
  );

  return { itemsFor, dialogs };
}
