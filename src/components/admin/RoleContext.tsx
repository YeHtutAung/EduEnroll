"use client";

import { createContext, useContext } from "react";
import type { UserRole } from "@/types/database";

const RoleContext = createContext<UserRole>("staff");

export function RoleProvider({
  role,
  children,
}: {
  role: UserRole;
  children: React.ReactNode;
}) {
  return <RoleContext.Provider value={role}>{children}</RoleContext.Provider>;
}

export function useRole(): UserRole {
  return useContext(RoleContext);
}
