// Project service. Domain records use snake_case fields (legacy storage shape).
export interface RawProject {
  id: string;
  owner_id: string;
  name: string;
  created_at: string;
  is_archived: boolean;
}

const PROJECTS: RawProject[] = [
  {
    id: "p1",
    owner_id: "u1",
    name: "Analytical Engine",
    created_at: "2024-02-01T00:00:00.000Z",
    is_archived: false,
  },
  {
    id: "p2",
    owner_id: "u1",
    name: "Translator Notes",
    created_at: "2024-02-10T00:00:00.000Z",
    is_archived: true,
  },
  {
    id: "p3",
    owner_id: "u1",
    name: "Bernoulli Numbers",
    created_at: "2024-04-05T00:00:00.000Z",
    is_archived: false,
  },
  {
    id: "p4",
    owner_id: "u2",
    name: "Compiler",
    created_at: "2024-03-20T00:00:00.000Z",
    is_archived: false,
  },
];

export function listProjectsByOwner(ownerId: string): RawProject[] {
  return PROJECTS.filter((project) => project.owner_id === ownerId);
}
