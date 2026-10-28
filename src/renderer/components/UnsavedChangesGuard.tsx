import { useBlocker } from 'react-router-dom';
import { ConfirmDialog } from './ui';

interface UnsavedChangesGuardProps {
  when: boolean;
  title?: string;
  description?: string;
  /** Optional save action offered alongside discarding */
  onSave?: () => Promise<void> | void;
  /** Navigation to paths under this prefix is allowed (e.g. switching tabs inside a project) */
  scope?: string;
}

/** Intercepts in-app navigation while there are unsaved changes. */
export function UnsavedChangesGuard({ when, title = 'Discard unsaved changes?', description = 'Your changes have not been saved.', onSave, scope }: UnsavedChangesGuardProps) {
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      when && currentLocation.pathname !== nextLocation.pathname && !(scope && nextLocation.pathname.startsWith(scope))
  );

  return (
    <ConfirmDialog
      open={blocker.state === 'blocked'}
      title={title}
      description={description}
      confirmLabel={onSave ? 'Save and leave' : 'Discard changes'}
      cancelLabel={onSave ? 'Stay' : 'Keep editing'}
      destructive={!onSave}
      onCancel={() => blocker.reset?.()}
      onConfirm={async () => {
        if (onSave) await onSave();
        blocker.proceed?.();
      }}
    />
  );
}
