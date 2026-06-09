// Vanity profile URL — okayspace.ca/<username> renders the same profile screen
// as /user/<name>. Static routes (settings, login, marketplace, …) take
// precedence over this single-segment dynamic route, so it only catches
// usernames. The shared screen reads the `username` param (see user/[name].tsx).
export { default } from "./user/[name]";
