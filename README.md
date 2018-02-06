# Seamless Mongodb Server

Server-side part for [Seamless](https://github.com/cyper8/seamless) data-binding client-side framework.
A development of [Seamless-Mongoose-Plugin](https://github.com/cyper8/seamless-mongoose-plugin).
I desided to drop dependency on Mongoose since it only uses a hooks system which is functional only if documents change happens within the _same_ instance of Model. After that those changed documents' ```_ids``` are to be unraveled to a list of cached requests which once have been answered with data that included those documents. And those requests if still polled by the client are to be reanswered with changed datasets, retrieved using corresponding cached queries.

It is complicated, slow and not scalable.

I want to replace Mongoose with mongodb driver. API endpoints middlewares are to be placed in a scalablle stateless worker supervised by a module, responsible for propagating data chages events whenever POST requests happen.
