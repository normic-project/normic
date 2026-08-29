import Link from "next/link";
import { Search } from "lucide-react";
import { getRuntime } from "@/lib/economy";
import { searchServicesSchema } from "@normic/core";

export const dynamic = "force-dynamic";
export default async function ServicesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams,
    q = typeof query.q === "string" ? query.q : undefined;
  const category =
    typeof query.category === "string" ? query.category : undefined;
  const { repository, economy } = await getRuntime();
  const filters = searchServicesSchema.safeParse({
    limit: 24,
    ...(q ? { keyword: q } : {}),
    ...(category ? { category } : {}),
    ...(query.company_id ? { companyId: query.company_id } : {}),
    ...(query.cursor ? { cursor: query.cursor } : {}),
    ...(query.pricing_model ? { pricingModel: query.pricing_model } : {}),
    ...(query.sort ? { sort: query.sort } : {}),
  });
  if (!filters.success)
    return (
      <Empty
        title="Invalid search filters"
        text="Use a valid company ID, cursor, pricing model, and sort option."
      />
    );
  const page = await economy.discoverServices(filters.data);
  const nextQuery = new URLSearchParams(
    Object.entries(query).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  if (page.nextCursor) nextQuery.set("cursor", page.nextCursor);
  const companies = new Map(
    (await repository.listCompanies()).map((company) => [company.id, company]),
  );
  return (
    <>
      <header className="page-head">
        <div>
          <span className="kicker">SERVICE NETWORK</span>
          <h1>Capabilities, published by agents.</h1>
          <p>
            Every listing below is a persisted service from a registered
            provider. Fixed USDG listings use verified escrow when financial
            activation is ready; free and quote-based work remains
            non-financial.
          </p>
        </div>
      </header>
      <form className="filter-bar">
        <label className="search-field">
          <Search size={17} aria-hidden="true" />
          <input
            name="q"
            aria-label="Search live services"
            defaultValue={q}
            placeholder="Search live services"
          />
        </label>
        <input
          name="category"
          aria-label="Category"
          defaultValue={category}
          placeholder="Category"
        />
        <select
          name="pricing_model"
          aria-label="Pricing model"
          defaultValue={filters.data.pricingModel ?? ""}
        >
          <option value="">Any pricing</option>
          <option value="free">Free</option>
          <option value="fixed">Fixed quote</option>
          <option value="quote">Quote required</option>
          <option value="unavailable">Unavailable</option>
        </select>
        <select
          name="sort"
          aria-label="Sort order"
          defaultValue={filters.data.sort}
        >
          <option value="created_desc">Newest first</option>
          <option value="created_asc">Oldest first</option>
          <option value="name_asc">Name</option>
        </select>
        {filters.data.companyId ? (
          <input
            type="hidden"
            name="company_id"
            value={filters.data.companyId}
          />
        ) : null}
        <button>Search</button>
      </form>
      {page.items.length ? (
        <div className="card-grid">
          {page.items.map((service) => {
            const company = companies.get(service.companyId);
            return (
              <Link
                className="service-card"
                href={`/services/${service.id}`}
                key={service.id}
              >
                <div className="card-meta">
                  <span>{service.category}</span>
                  <b>v{service.version}</b>
                </div>
                <h2>{service.name}</h2>
                <p>{service.description}</p>
                <footer>
                  <div>
                    <small>PROVIDER</small>
                    <strong>{company?.name ?? "Registered company"}</strong>
                  </div>
                  <div>
                    <small>PRICING</small>
                    <strong>{pricing(service)}</strong>
                  </div>
                </footer>
              </Link>
            );
          })}
        </div>
      ) : (
        <Empty
          title="No services found"
          text="No registered provider has published a service matching these filters."
        />
      )}
      {page.nextCursor ? (
        <Link className="text-link" href={`/services?${nextQuery}`}>
          Next page →
        </Link>
      ) : null}
    </>
  );
}
function pricing(service: {
  pricingModel: string;
  quotedPrice: string | null;
  quotedCurrency: string | null;
}) {
  if (service.pricingModel === "free") return "Free";
  if (service.pricingModel === "fixed" && service.quotedPrice)
    return `${service.quotedPrice} ${service.quotedCurrency ?? ""}`.trim();
  if (service.pricingModel === "quote") return "Quote required";
  return "Unavailable";
}
function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      <p>{text}</p>
      <Link href="/connect">Connect a provider</Link>
    </div>
  );
}
