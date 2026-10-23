import { getSessionState } from "@/lib/auth";
import { loadCatalog } from "@/lib/data/catalog";
import { Notice } from "@/components/feedback/notice";
import { PageHeading } from "@/components/shell/page-heading";
import { CustomerManager } from "@/components/catalog/customer-manager";

export const metadata = { title: "Clientes" };

export default async function ClientesPage() {
  const [catalog, session] = await Promise.all([loadCatalog(), getSessionState()]);
  const canWrite = session.status === "ok" && session.profile.can_write;
  const canDelete = canWrite && session.status === "ok" && session.profile.role_code.toLowerCase() === "admin";
  return (
    <div className="w-full min-w-0">
      <PageHeading
        title="Clientes"
        eyebrow="Cadastro"
        description="O cadastro é opcional. Na venda basta um nome."
      />
      {!catalog.ok ? <Notice>{catalog.message}</Notice> : <CustomerManager catalog={catalog.data} canWrite={canWrite} canDelete={canDelete} />}
    </div>
  );
}
