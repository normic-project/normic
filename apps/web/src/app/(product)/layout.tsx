import { ProductShell } from "@/components/product-shell";

export default function ProductLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return <ProductShell>{children}</ProductShell>;
}
