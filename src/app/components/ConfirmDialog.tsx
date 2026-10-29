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
  onConfirm: () => void;
  size?: "sm" | "base" | "lg" | "xl";
}) {
  const t = useT();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog size={size} className="p-6">
        <div className="mb-3 flex items-start justify-between gap-4">
          <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
          <Dialog.Close render={(p) => <Button {...p} variant="ghost" size="sm" shape="square" icon={XIcon} aria-label={t.common.close} />} />
        </div>
        {description && <Dialog.Description className="text-sm text-kumo-subtle">{description}</Dialog.Description>}
        {children && <div className="mt-4 flex flex-col gap-3">{children}</div>}
        <div className="mt-6 flex justify-end gap-2">
          <Dialog.Close render={(p) => <Button {...p} variant="secondary">{t.common.cancel}</Button>} />
          <Button variant={danger ? "destructive" : "primary"} loading={busy} onClick={onConfirm}>
            {confirm}
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
