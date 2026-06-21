export type NavLink = {
  href: string;
  label: string;
  exact?: boolean;
};

export type NavGroup = {
  label: string;
  links: NavLink[];
};

export type NavConfig = {
  primary: NavLink[];
  groups: NavGroup[];
};

export const NAV_CONFIG: NavConfig = {
  primary: [
    { href: "/", label: "Home", exact: true },
    { href: "/dashboard", label: "Dashboard" },
    { href: "/connect", label: "GBP Connection" },
    { href: "/posts", label: "Post Queue" },
    { href: "/reviews", label: "Review Responses" },
    { href: "/rankings", label: "Keyword Rankings" },
  ],
  groups: [
    {
      label: "Automation",
      links: [
        { href: "/connect", label: "GBP Connection" },
        { href: "/posts", label: "Post Queue" },
        { href: "/reviews", label: "Review Response Queue" },
      ],
    },
    {
      label: "Insights",
      links: [
        { href: "/dashboard", label: "Activity Dashboard" },
        { href: "/rankings", label: "Keyword Rankings Report" },
      ],
    },
  ],
};
