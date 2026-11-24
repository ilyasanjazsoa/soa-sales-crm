import { MeResponse } from "@soa/shared";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError, setCsrfToken } from "./api";

export const ME_KEY = ["me"] as const;

/** The signed-in user, or null when there is no session. */
export function useMe() {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: async () => {
      try {
        const me = await api("/api/me", MeResponse);
        setCsrfToken(me.csrfToken);
        return me;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          setCsrfToken(undefined);
          return null;
        }
        throw error;
      }
    },
    staleTime: 60_000,
  });
}
