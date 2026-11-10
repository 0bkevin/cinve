// Cache lifetimes by how fast the data changes. Seats are never cached.
export const hourTtl = 3600000, catalogTtl = 120000;
/** A Next.js page that still carries its data stream; anything else is not cached. */
export const flightPage = (body: string) => body.includes('self.__next_f.push(');
