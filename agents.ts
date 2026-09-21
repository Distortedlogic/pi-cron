import { type Static, Type } from "typebox";

const exact = { additionalProperties: false } as const;

export const configurationSchema = Type.Record(
	Type.String({ pattern: "\\S" }),
	Type.Object(
		{
			schedule: Type.String({ minLength: 1 }),
			chain: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
		},
		exact,
	),
	{ additionalProperties: false },
);

export type Configuration = Static<typeof configurationSchema>;
