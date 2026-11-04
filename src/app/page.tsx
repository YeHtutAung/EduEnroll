import type { Metadata } from "next";
import MarketingPage from "@/components/marketing/MarketingPage";
import { getPublishedMarketingContent } from "@/lib/marketing/published";

export async function generateMetadata(): Promise<Metadata> {
  const { seo } = await getPublishedMarketingContent();
  return {
    title: seo.title,
    description: seo.description,
    openGraph: {
      title: seo.title,
      description: seo.description,
      siteName: "KuuNyi",
      locale: "my_MM",
      type: "website",
    },
    twitter: {
      title: seo.title,
      description: seo.description,
    },
  };
}

export default async function LandingPage() {
  const content = await getPublishedMarketingContent();
  return <MarketingPage content={content} />;
}
