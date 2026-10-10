// Drop missing values (null, undefined) from a list, keeping everything else.
export const keepValues = (values) => values.filter(Boolean);
