import { useEffect, useState } from "react";

export type Route =
  | { readonly name: "landing" }
  | { readonly name: "run"; readonly shareId: string }
  | { readonly name: "page"; readonly shareId: string; readonly pageId: string; readonly view: "side" | "all" };

export const parse = (path: string, search: string): Route => {
  const page = /^\/r\/([^/]+)\/p\/([^/]+)$/.exec(path);
  if (page?.[1] && page[2])
    return {
      name: "page",
      shareId: page[1],
      pageId: page[2],
      view: new URLSearchParams(search).get("view") === "all" ? "all" : "side",
    };
  const run = /^\/r\/([^/]+)$/.exec(path);
  if (run?.[1]) return { name: "run", shareId: run[1] };
  return { name: "landing" };
};

export const navigate = (to: string) => {
  history.pushState(null, "", to);
  dispatchEvent(new PopStateEvent("popstate"));
};

export const useRoute = () => {
  const [route, setRoute] = useState(() => parse(location.pathname, location.search));
  useEffect(() => {
    const update = () => setRoute(parse(location.pathname, location.search));
    addEventListener("popstate", update);
    return () => removeEventListener("popstate", update);
  }, []);
  return route;
};
