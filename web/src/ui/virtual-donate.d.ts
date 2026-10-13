declare module 'virtual:donate' {
  const data: {
    links: { id: string; name: string; url: string; note?: string }[];
    coins: { id: string; name: string; address: string; qr: string; note?: string }[];
  };
  export default data;
}
