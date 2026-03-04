import { httpRouter } from "convex/server";
import { handleWaitlistSignup } from "./waitlist";

const http = httpRouter();

http.route({
  path: "/waitlist",
  method: "POST",
  handler: handleWaitlistSignup,
});

http.route({
  path: "/waitlist",
  method: "OPTIONS",
  handler: handleWaitlistSignup,
});

export default http;
