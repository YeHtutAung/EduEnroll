// Bare layout for the enrollment landing page.
// Templates render their own full-page header/footer, so we strip the
// public layout's max-w-4xl container and shared header/footer here.
export default function EnrollSlugLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
