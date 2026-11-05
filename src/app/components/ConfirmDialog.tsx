import { Button, Dialog } from "@cloudflare/kumo";
import { XIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useT } from "../i18n";

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirm,
  danger,
  busy,
  disabled,
  back,
  onConfirm,
  size = "base",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  confirm: string;
  danger?: boolean;
  busy?: boolean;
  disabled?: boolean;
  /** In place of Cancel, a step back (such as from a review to the form). */
  back?: { label: string; onClick: () => void };
  onConfirm: () => void;
  size?: "sm" | "base" | "lg" | "xl";
}) {
  const t = useT();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {/* On small screens the content scrolls, title and buttons stay in view. */}
      <Dialog size={size} className="flex max-h-[calc(100dvh-2rem)] flex-col">
        <div className="flex items-start justify-between gap-4 px-6 pt-6 pb-3">
          <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
          <Dialog.Close render={(p) => <Button {...p} variant="ghost" size="sm" shape="square" icon={XIcon} aria-label={t.common.close} />} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6">
          {description && <Dialog.Description className="text-sm text-kumo-subtle">{description}</Dialog.Description>}
          {children && <div className="mt-4 flex flex-col gap-3 pb-1">{children}</div>}
        </div>
        <div className="flex justify-end gap-2 px-6 pt-4 pb-6">
          {back ? (
            <Button variant="secondary" onClick={back.onClick}>
              {back.label}
            </Button>
          ) : (
            <Dialog.Close render={(p) => <Button {...p} variant="secondary">{t.common.cancel}</Button>} />
          )}
          <Button variant={danger ? "destructive" : "primary"} loading={busy} disabled={disabled} onClick={onConfirm}>
            {confirm}
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
