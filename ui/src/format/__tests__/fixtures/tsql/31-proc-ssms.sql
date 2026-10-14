SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
-- =============================================
-- Author:      dbstudio
-- Description: Gets a customer with orders
-- =============================================
CREATE PROCEDURE [dbo].[GetCustomerOrders]
	@CustomerId int,
	@From date = NULL,
	@Count int OUTPUT
AS
BEGIN
	-- SET NOCOUNT ON added to prevent extra result sets from
	-- interfering with SELECT statements.
	SET NOCOUNT ON;

	SELECT o.[Id], o.[Total], o.[OrderDate]
	FROM [dbo].[Orders] o
	WHERE o.[CustomerId] = @CustomerId AND (@From IS NULL OR o.[OrderDate] >= @From)

	SET @Count = @@ROWCOUNT
END
GO
