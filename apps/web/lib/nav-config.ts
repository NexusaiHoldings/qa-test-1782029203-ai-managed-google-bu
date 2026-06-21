export const NAV_CONFIG = {
  primary: [
    { label: "Dashboard", href: "/dashboard" },
    { label: "Connect", href: "/connect" },
    { label: "Posts", href: "/posts" },
    { label: "Reviews", href: "/reviews" },
    { label: "Rankings", href: "/rankings" },
  ],
  groups: [
    {
      label: "Google Business Profile",
      items: [
        { label: "Connect", href: "/connect" },
        { label: "Post Queue", href: "/posts" },
        { label: "Review Queue", href: "/reviews" },
      ],
    },
    {
      label: "Reports",
      items: [{ label: "Keyword Rankings", href: "/rankings" }],
    },
  ],
};
