"use client";

import { createContext, useContext } from "react";

export interface TenantLabels {
  intake: string;
  class: string;
  student: string;
  seat: string;
  fee: string;
  orgType: string;
}

const DEFAULT_LABELS: TenantLabels = {
  intake: "Intake",
  class: "Class Type",
  student: "Student",
  seat: "Seat",
  fee: "Fee",
  orgType: "language_school",
};

const TenantLabelsContext = createContext<TenantLabels>(DEFAULT_LABELS);

export function TenantLabelsProvider({
  labels,
  children,
}: {
  labels: TenantLabels;
  children: React.ReactNode;
}) {
  return (
    <TenantLabelsContext.Provider value={labels}>
      {children}
    </TenantLabelsContext.Provider>
  );
}

export function useTenantLabels(): TenantLabels {
  return useContext(TenantLabelsContext);
}
