import { auth, currentUser } from "./api.ts";
import { Nav } from "./Nav.tsx";
import { navigate } from "./router.ts";
import { SignIn } from "./SignIn.tsx";

/** Only same-site OAuth consent pages; anything else goes home. */
const safeNext = (next: string) => (next.startsWith("/oauth/authorize?") ? next : "/");

/** /signin?next=: sign in, then continue to an agent's consent page. */
export const SignInPage = ({ next }: { readonly next: string }) => {
  const done = () => location.assign(safeNext(next));
  if (currentUser()) done();
  return (
    <div>
      <Nav user={null} />
      <SignIn
        onEmail={(email, turnstile) => auth.start(email, [], turnstile).then(() => undefined)}
        onDone={done}
        onCancel={() => navigate("/")}
      />
    </div>
  );
};
