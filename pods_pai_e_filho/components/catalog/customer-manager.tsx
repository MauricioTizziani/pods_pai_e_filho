"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Phone, Trash2, UserPlus, Users } from "lucide-react";
import { deleteCustomerAction, saveCustomerAction } from "@/lib/actions/catalog";
import type { CatalogSnapshot, Customer } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, Select, TextArea } from "@/components/ui/field";
import { Notice } from "@/components/feedback/notice";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function CustomerManager({
  catalog,
  canWrite,
  canDelete,
}: {
  catalog: CatalogSnapshot;
  canWrite: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<Customer | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [typeId, setTypeId] = useState("");
  const [active, setActive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Customer | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletedIds, setDeletedIds] = useState<Set<string>>(() => new Set());
  const [pending, startTransition] = useTransition();
  const mutationInFlight = useRef(false);
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const types = catalog.customerTypes.filter((type) => type.active);
  const customers = catalog.customers.filter((customer) => !deletedIds.has(customer.id));

  useEffect(() => {
    const dialog = deleteDialog.current;
    if (!dialog) return;
    if (deleting && canDelete && !dialog.open) dialog.showModal();
    if ((!deleting || !canDelete) && dialog.open) dialog.close();
  }, [deleting, canDelete]);

  function edit(customer: Customer) {
    setEditing(customer);
    setName(customer.name);
    setPhone(customer.phone ?? "");
    setNotes(customer.notes ?? "");
    setTypeId(customer.customer_type_id ?? "");
    setActive(customer.active);
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function reset() {
    setEditing(null);
    setName("");
    setPhone("");
    setNotes("");
    setTypeId("");
    setActive(true);
  }

  function confirmDelete(customer: Customer) {
    if (!canDelete || pending || mutationInFlight.current) return;
    setDeleteError(null);
    setDeleting(customer);
  }

  function removeCustomer() {
    if (!deleting || !canDelete || pending || mutationInFlight.current) return;
    const customer = deleting;
    mutationInFlight.current = true;
    setDeleteError(null);
    setError(null);
    setMessage(null);
    startTransition(async () => {
      try {
        const result = await deleteCustomerAction(customer.id);
        if (!result.ok) {
          setDeleteError(result.message);
          return;
        }
        setDeletedIds((current) => new Set(current).add(customer.id));
        if (editing?.id === customer.id) reset();
        setDeleting(null);
        setMessage(`Cliente ${customer.name} excluído. As vendas e pendências foram mantidas.`);
        router.refresh();
      } catch {
        setDeleteError("Não foi possível excluir o cliente. Tente novamente.");
      } finally {
        mutationInFlight.current = false;
      }
    });
  }

  return (
    <div className="grid w-full min-w-0 gap-5">
      {canWrite ? (
        <Panel
          title={editing ? "Editar cliente" : "Novo cliente"}
          description={editing ? `Alterando ${editing.name}` : "Cadastro opcional, mas ajuda a escolher o preço certo"}
          icon={UserPlus}
          accent={Boolean(editing)}
        >
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (pending || mutationInFlight.current) return;
              mutationInFlight.current = true;
              setError(null);
              setMessage(null);
              startTransition(async () => {
                try {
                  const result = await saveCustomerAction({
                    id: editing?.id,
                    name,
                    phone,
                    notes,
                    customerTypeId: typeId,
                    active,
                  });
                  if (!result.ok) {
                    setError(result.message);
                    return;
                  }
                  setMessage(editing ? "Cliente atualizado." : "Cliente cadastrado.");
                  reset();
                  router.refresh();
                } catch {
                  setError("Não foi possível salvar o cliente. Tente novamente.");
                } finally {
                  mutationInFlight.current = false;
                }
              });
            }}
          >
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Nome">
                <Input className="h-12" value={name} onChange={(event) => setName(event.target.value)} required />
              </Field>
              <Field label="Telefone">
                <Input className="h-12" value={phone} inputMode="tel" onChange={(event) => setPhone(event.target.value)} />
              </Field>
              <Field label="Tipo padrão">
                <Select value={typeId} onChange={(event) => setTypeId(event.target.value)}>
                  <option value="">Sem tipo padrão</option>
                  {types.map((type) => (
                    <option key={type.id} value={type.id}>
                      {type.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Observações" className="md:col-span-2">
                <TextArea value={notes} onChange={(event) => setNotes(event.target.value)} />
              </Field>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="lg" disabled={pending}>
                {pending ? "Salvando..." : "Salvar cliente"}
              </Button>
              {editing ? (
                <Button type="button" variant="ghost" size="lg" disabled={pending} onClick={reset}>
                  Cancelar
                </Button>
              ) : null}
              {editing && canDelete ? (
                <Button type="button" variant="destructive" size="lg" disabled={pending} onClick={() => confirmDelete(editing)}>
                  <Trash2 />
                  Excluir cliente
                </Button>
              ) : null}
            </div>
          </form>
        </Panel>
      ) : null}
      {message ? <Notice tone="success">{message}</Notice> : null}
      {error ? <Notice>{error}</Notice> : null}

      <Panel
        title="Clientes cadastrados"
        description={`${customers.length} cliente(s)`}
        icon={Users}
        bodyClassName="p-0"
      >
        {customers.length === 0 ? (
          <div className="p-4">
            <EmptyState title="Nenhum cliente cadastrado" description="Você pode vender só com o nome." />
          </div>
        ) : (
          <ul className="divide-y divide-border/70">
            {customers.map((customer) => {
              const type = catalog.customerTypes.find((item) => item.id === customer.customer_type_id);
              return (
                <li
                  key={customer.id}
                  className={cn(
                    "flex items-start gap-3 px-4 py-3 transition-colors hover:bg-primary/5",
                    !customer.active && "opacity-60",
                  )}
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-primary/30 bg-primary/10 font-display text-xs font-bold text-primary">
                    {initials(customer.name)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold">{customer.name}</p>
                      {type ? <Badge variant="neutral">{type.name}</Badge> : null}
                      {!customer.active ? <Badge variant="outline">inativo</Badge> : null}
                    </div>
                    <p className="mt-0.5 flex items-center gap-1.5 text-sm text-muted-foreground">
                      <Phone className="h-3.5 w-3.5" />
                      {customer.phone || "Sem telefone"}
                    </p>
                    {customer.notes ? <p className="mt-1 text-sm text-muted-foreground">{customer.notes}</p> : null}
                  </div>
                  <div className="flex shrink-0 flex-wrap justify-end gap-2">
                    {canWrite ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                        disabled={pending}
                        onClick={() => edit(customer)}
                        aria-label={`Editar ${customer.name}`}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        <span className="hidden sm:inline">Editar</span>
                      </Button>
                    ) : null}
                    {canDelete ? (
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        disabled={pending}
                        onClick={() => confirmDelete(customer)}
                        aria-label={`Excluir cliente ${customer.name}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        <span className="hidden sm:inline">Excluir cliente</span>
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
      {canDelete ? (
        <dialog
          ref={deleteDialog}
          aria-labelledby="delete-customer-title"
          aria-describedby="delete-customer-description"
          className="fixed inset-0 m-auto w-[calc(100%-2rem)] max-w-md rounded-lg border border-border bg-background p-5 text-foreground shadow-xl backdrop:bg-black/60"
          onCancel={(event) => {
            if (pending || mutationInFlight.current) event.preventDefault();
            else setDeleting(null);
          }}
          onClose={() => {
            if (!mutationInFlight.current) setDeleting(null);
          }}
        >
          <h3 id="delete-customer-title" className="break-words font-display text-lg font-semibold">
            Excluir cliente {deleting?.name}?
          </h3>
          <p id="delete-customer-description" className="mt-2 text-sm text-muted-foreground">
            O cadastro será excluído. As vendas existentes serão mantidas com o nome do cliente, mas deixarão de estar vinculadas a este cadastro. Valores, pagamentos e pendências não serão alterados.
          </p>
          {deleteError ? <div className="mt-4"><Notice>{deleteError}</Notice></div> : null}
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Button type="button" variant="ghost" disabled={pending} onClick={() => setDeleting(null)} autoFocus>
              Cancelar
            </Button>
            <Button type="button" variant="destructive" disabled={pending} onClick={removeCustomer}>
              {pending ? "Excluindo..." : "Excluir cliente"}
            </Button>
          </div>
        </dialog>
      ) : null}
    </div>
  );
}
