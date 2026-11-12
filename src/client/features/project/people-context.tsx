/**
 * The board's people directory, for the surfaces that draw a card without holding the bundle.
 *
 * A card face is drawn by the board, the list, the gallery and the day panel, none of which receive
 * the whole bundle; the directory is board-scoped, so it travels as context rather than as a prop on
 * every view in between.
 */
import { createContext, useContext, type ReactElement, type ReactNode } from 'react'
import type { ProjectPeople } from '@shared/project/model'

const PeopleContext = createContext<ProjectPeople>({})

export function ProjectPeopleProvider({ people, children }: { people: ProjectPeople, children: ReactNode }): ReactElement {
  return <PeopleContext.Provider value={people}>{children}</PeopleContext.Provider>
}

export function useProjectPeople(): ProjectPeople {
  return useContext(PeopleContext)
}