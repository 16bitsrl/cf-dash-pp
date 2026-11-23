import { Button, Empty } from "@cloudflare/kumo";
import { CheckCircleIcon, LockSimpleIcon } from "@phosphor-icons/react";
import { Container, PageHeader } from "../components/ui";
import { useT } from "../i18n";
import type { Me } from "../lib/api";
import { useAction } from "../lib/hooks";

/** An account of theirs that is not enabled: who manages it can ask for it. */
export function RequestAccess({ me, acc, onMeChange }: { me: Me; acc: string; onMeChange: () => void }) {
  const t = useT();
  const { run, busy } = useAction();
  const account = me.accounts.find((a) => a.id === acc)!;
  return (
    <>
      <PageHeader title={account.name} />
      <Container className="pt-10">
        {account.requested ? (
          <Empty icon={<CheckCircleIcon size={48} className="text-kumo-success" />} title={t.home.requestSent} description={me.notifications ? t.home.requestSentEmail : t.home.requestSentNoEmail} />
        ) : (
          <Empty
            icon={<LockSimpleIcon size={48} />}
            title={t.home.requestTitle}
            description={`${t.home.requestText} ${account.canRequest ? "" : t.home.requestNotManager}`.trim()}
            contents={
              account.canRequest && (
                <Button variant="primary" loading={busy} onClick={async () => (await run("POST", "/tenant-requests", { accountId: acc }, t.home.requestSent)) && onMeChange()}>
                  {t.home.requestButton}
                </Button>
              )
            }
          />
        )}
      </Container>
    </>
  );
}
